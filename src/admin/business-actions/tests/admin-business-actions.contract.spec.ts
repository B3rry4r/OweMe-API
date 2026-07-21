import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { PrismaModule } from '../../../prisma/prisma.module';
import { PrismaService } from '../../../prisma/prisma.service';
import { CommonModule } from '../../../common/common.module';
import { HttpExceptionFilter } from '../../../common/filters/http-exception.filter';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { uuidv7 } from '../../../common';
import { currentPeriodStart } from '../../../usage/period.util';
import { AdminModule } from '../../admin.module';
import { hashPassword } from '../../common';
import { AdminBusinessActionsModule } from '../admin-business-actions.module';
import { ENTERPRISE_BAND_CEILING_KOBO } from '../admin-business-actions.service';

// Admin secrets are env-driven with no insecure fallback; specs boot with explicit
// test values, mirroring how test/setenv.ts boots the user-auth specs.
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET ?? 'test-admin-access-secret';
process.env.ADMIN_JWT_REFRESH_SECRET =
  process.env.ADMIN_JWT_REFRESH_SECRET ?? 'test-admin-refresh-secret';

/**
 * AdminBusinessActions (contract). Same boot as app.module (global user guards,
 * ValidationPipe, HttpExceptionFilter) + AdminModule (for admin login) + this resource's
 * module, which the integrator later aggregates into AdminModule.
 *
 * Covers: auth required and user-token cross-rejection, the superadmin-only role gate on
 * every route, each endpoint's happy path asserting BOTH the state change AND the audit
 * row, every refusal path (404 / 422 / the structural 403 on reset-test), the reset wipe's
 * tenant isolation, and re-run safety on all seven actions.
 */
describe('AdminBusinessActions (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const ROOT_EMAIL = 'root-actions@oweme.app';
  const ROOT_PASSWORD = 'RootPass!2026';
  const SUPPORT_EMAIL = 'support-actions@oweme.app';
  const SUPPORT_PASSWORD = 'SupportPass!1';
  let rootAccess: string;
  let supportAccess: string;
  let rootAdminId: string;

  // Distinctive tenant ids so this suite never collides with other waves' seeded rows.
  const BIZ_FLAG = '01919ccc-dddd-7eee-8fff-actionbiz0flag';
  const BIZ_CREDITS = '01919ccc-dddd-7eee-8fff-actionbiz0cred';
  const BIZ_PLAN = '01919ccc-dddd-7eee-8fff-actionbiz0plan';
  const BIZ_ENTERPRISE = '01919ccc-dddd-7eee-8fff-actionbiz00ent';
  const BIZ_SUSPEND = '01919ccc-dddd-7eee-8fff-actionbiz0susp';
  const BIZ_RESET = '01919ccc-dddd-7eee-8fff-actionbiz0rset';
  const BIZ_NEIGHBOUR = '01919ccc-dddd-7eee-8fff-actionbiz0nbr0';

  const RESET_NAME = 'Sandbox Kitchen';
  const NEIGHBOUR_NAME = 'Other Sandbox';

  const post = (path: string, body: unknown = {}, token: string = rootAccess) =>
    request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);

  const login = (email: string, password: string) =>
    request(app.getHttpServer()).post('/admin/auth/login').send({ email, password });

  /** Newest audit row of a given actionType for a business. */
  const lastAudit = async (actionType: string, businessId: string) =>
    prisma.adminAuditLog.findFirst({
      where: { actionType, targetBusinessId: businessId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

  const auditCount = (actionType: string, businessId: string) =>
    prisma.adminAuditLog.count({ where: { actionType, targetBusinessId: businessId } });

  const seedBusiness = async (
    id: string,
    businessName: string,
    phone: string,
    plan: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    await prisma.business.create({
      data: {
        id,
        businessName,
        ownerName: 'Owner',
        phone,
        category: 'Retail',
        currency: 'NGN (₦)',
        reminderTone: 'friendly',
        plan,
        ...extra,
      },
    });
  };

  /** A full slice of tenant-owned domain rows, used to prove the reset wipe's scope. */
  const seedDomainRows = async (businessId: string, tag: string): Promise<void> => {
    const customerId = uuidv7();
    const debtId = uuidv7();
    await prisma.customer.create({
      data: { id: customerId, businessId, name: `Customer ${tag}`, phone: '08030000000' },
    });
    await prisma.debt.create({
      data: { id: debtId, businessId, customerId, amount: 250_000 },
    });
    await prisma.payment.create({
      data: {
        id: uuidv7(),
        businessId,
        debtId,
        amount: 50_000,
        method: 'Cash',
        reference: `OWM-${tag}`,
      },
    });
    await prisma.reminder.create({
      data: { id: uuidv7(), businessId, debtId, channel: 'sms', status: 'sent' },
    });
    await prisma.notification.create({
      data: { id: uuidv7(), businessId, title: 'Payment received', kind: 'payment' },
    });
    await prisma.usageEvent.create({
      data: { id: uuidv7(), businessId, type: 'send', credits: 5 },
    });
  };

  const domainCounts = async (businessId: string) => ({
    customers: await prisma.customer.count({ where: { businessId } }),
    debts: await prisma.debt.count({ where: { businessId } }),
    payments: await prisma.payment.count({ where: { businessId } }),
    reminders: await prisma.reminder.count({ where: { businessId } }),
    notifications: await prisma.notification.count({ where: { businessId } }),
    usageEvents: await prisma.usageEvent.count({ where: { businessId } }),
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // AdminBusinessActionsModule is imported explicitly: the integrator aggregates it into
      // AdminModule after this wave, so the spec must not depend on that edit landing.
      imports: [PrismaModule, CommonModule, AdminModule, AdminBusinessActionsModule],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    await app.init();

    await prisma.adminAuditLog.deleteMany({});
    await prisma.adminRefreshToken.deleteMany({});
    await prisma.adminUser.deleteMany({});
    for (const [email, name, role, password] of [
      [ROOT_EMAIL, 'Actions Root', 'superadmin', ROOT_PASSWORD],
      [SUPPORT_EMAIL, 'Actions Support', 'support', SUPPORT_PASSWORD],
    ]) {
      await prisma.adminUser.create({
        data: {
          id: uuidv7(),
          email,
          name,
          passwordHash: hashPassword(password),
          role,
          status: 'active',
          mustChangePassword: false,
        },
      });
    }
    rootAccess = (await login(ROOT_EMAIL, ROOT_PASSWORD)).body.accessToken as string;
    supportAccess = (await login(SUPPORT_EMAIL, SUPPORT_PASSWORD)).body.accessToken as string;
    rootAdminId = (await prisma.adminUser.findUniqueOrThrow({ where: { email: ROOT_EMAIL } })).id;

    // These actions write to the whole tenant table, so the fixture set is the whole table.
    await prisma.usageEvent.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.reminder.deleteMany({});
    await prisma.debt.deleteMany({});
    await prisma.customer.deleteMany({});
    await prisma.staff.deleteMany({});
    await prisma.billingTransaction.deleteMany({});
    await prisma.creditLedger.deleteMany({});
    await prisma.subscription.deleteMany({});
    await prisma.notification.deleteMany({});
    await prisma.notificationPreferences.deleteMany({});
    await prisma.payoutAccount.deleteMany({});
    await prisma.business.deleteMany({});

    await seedBusiness(BIZ_FLAG, 'Flag Shop', '2348030001111', 'starter');
    await seedBusiness(BIZ_CREDITS, 'Credit Shop', '2348030002222', 'starter');
    await seedBusiness(BIZ_PLAN, 'Plan Shop', '2348030003333', 'starter');
    await seedBusiness(BIZ_ENTERPRISE, 'Wholesale Depot', '2348030004444', 'enterprise');
    await seedBusiness(BIZ_SUSPEND, 'Suspend Shop', '2348030005555', 'market');
    // Two TEST-flagged tenants: only the id distinguishes them, so a wipe that leaked
    // across tenants could not hide behind the flag filter.
    await seedBusiness(BIZ_RESET, RESET_NAME, '2348030006666', 'market', { isTest: true });
    await seedBusiness(BIZ_NEIGHBOUR, NEIGHBOUR_NAME, '2348030007777', 'market', { isTest: true });

    await seedDomainRows(BIZ_RESET, '00001');
    await seedDomainRows(BIZ_NEIGHBOUR, '00002');
  });

  afterAll(async () => {
    await app.close();
  });

  // ---------------------------------------------------------------------------
  // Auth + role gate
  // ---------------------------------------------------------------------------

  describe('auth + role gate', () => {
    const routes = (id: string): [string, unknown][] => [
      [`/admin/businesses/${id}/test-flag`, { isTest: true }],
      [`/admin/businesses/${id}/grant-credits`, { credits: 10 }],
      [`/admin/businesses/${id}/force-plan`, { plan: 'market' }],
      [`/admin/businesses/${id}/enterprise-bands`, { extraBands: 1 }],
      [`/admin/businesses/${id}/reset-test`, { confirm: 'x' }],
      [`/admin/businesses/${id}/suspend`, {}],
      [`/admin/businesses/${id}/unsuspend`, {}],
    ];

    it('no token -> 401 UNAUTHENTICATED on every action', async () => {
      for (const [path, body] of routes(BIZ_FLAG)) {
        const res = await request(app.getHttpServer())
          .post(path)
          .send(body as object);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('a USER token is rejected on the admin surface -> 401', async () => {
      const userToken = jwt.sign(
        { sub: 'user-owner', businessId: BIZ_FLAG, role: 'owner' },
        { secret: process.env.JWT_ACCESS_SECRET ?? 'test-access-secret', expiresIn: '1h' },
      );
      for (const [path, body] of routes(BIZ_FLAG)) {
        const res = await request(app.getHttpServer())
          .post(path)
          .set('Authorization', `Bearer ${userToken}`)
          .send(body as object);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('support is blocked on every action -> 403 FORBIDDEN (superadmin only)', async () => {
      for (const [path, body] of routes(BIZ_FLAG)) {
        const res = await post(path, body, supportAccess);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      }
    });

    it('a refused call changes nothing and writes no audit row', async () => {
      const business = await prisma.business.findUniqueOrThrow({ where: { id: BIZ_FLAG } });
      expect(business.isTest).toBe(false);
      expect(business.suspendedAt).toBeNull();
      // Admin logins are audited by the auth module; no BUSINESS row exists yet.
      expect(await prisma.adminAuditLog.count({ where: { targetType: 'Business' } })).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /admin/businesses/:id/test-flag
  // ---------------------------------------------------------------------------

  describe('POST /admin/businesses/:id/test-flag', () => {
    it('marks a business as a test account and audits the change', async () => {
      const res = await post(`/admin/businesses/${BIZ_FLAG}/test-flag`, { isTest: true });
      expect(res.status).toBe(201);
      expect(res.body.id).toBe(BIZ_FLAG);
      expect(res.body.isTest).toBe(true);

      const row = await prisma.business.findUniqueOrThrow({ where: { id: BIZ_FLAG } });
      expect(row.isTest).toBe(true);

      const entry = await lastAudit('test-flag', BIZ_FLAG);
      expect(entry).not.toBeNull();
      expect(entry!.adminUserId).toBe(rootAdminId);
      expect(entry!.adminRoleSnapshot).toBe('superadmin');
      expect(entry!.targetType).toBe('Business');
      expect(entry!.targetId).toBe(BIZ_FLAG);
      expect(entry!.before).toEqual({ isTest: false });
      expect(entry!.after).toEqual({ isTest: true });
    });

    it('is safe to re-run: same state, honest unchanged before/after', async () => {
      const res = await post(`/admin/businesses/${BIZ_FLAG}/test-flag`, { isTest: true });
      expect(res.status).toBe(201);
      expect((await prisma.business.findUniqueOrThrow({ where: { id: BIZ_FLAG } })).isTest).toBe(
        true,
      );
      const entry = await lastAudit('test-flag', BIZ_FLAG);
      expect(entry!.before).toEqual({ isTest: true });
      expect(entry!.after).toEqual({ isTest: true });
      expect(await auditCount('test-flag', BIZ_FLAG)).toBe(2);
    });

    it('unmarks the flag again', async () => {
      const res = await post(`/admin/businesses/${BIZ_FLAG}/test-flag`, { isTest: false });
      expect(res.status).toBe(201);
      expect(res.body.isTest).toBe(false);
      expect((await prisma.business.findUniqueOrThrow({ where: { id: BIZ_FLAG } })).isTest).toBe(
        false,
      );
    });

    it('rejects a missing or non-boolean body -> 422 VALIDATION_ERROR', async () => {
      for (const body of [{}, { isTest: 'yes' }, { isTest: true, extra: 1 }]) {
        const res = await post(`/admin/businesses/${BIZ_FLAG}/test-flag`, body);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('unknown id -> 404 NOT_FOUND', async () => {
      const res = await post(`/admin/businesses/${uuidv7()}/test-flag`, { isTest: true });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /admin/businesses/:id/grant-credits
  // ---------------------------------------------------------------------------

  describe('POST /admin/businesses/:id/grant-credits', () => {
    it('increments the ledger (never an absolute set) and audits before/after', async () => {
      await prisma.creditLedger.create({
        data: {
          businessId: BIZ_CREDITS,
          balance: 30,
          monthlyGrant: 50,
          periodStart: currentPeriodStart(),
        },
      });

      const res = await post(`/admin/businesses/${BIZ_CREDITS}/grant-credits`, { credits: 25 });
      expect(res.status).toBe(201);
      expect(res.body.grant).toBe(50);
      expect(res.body.bonusCredits).toBe(5); // balance 55 above the 50 grant

      const ledger = await prisma.creditLedger.findUniqueOrThrow({
        where: { businessId: BIZ_CREDITS },
      });
      expect(ledger.balance).toBe(55);
      expect(ledger.monthlyGrant).toBe(50);

      const entry = await lastAudit('grant-credits', BIZ_CREDITS);
      expect(entry!.before).toEqual({ balance: 30 });
      expect(entry!.after).toEqual({ balance: 55, granted: 25 });
    });

    it('re-running grants again (additive by contract) and never overwrites the balance', async () => {
      const res = await post(`/admin/businesses/${BIZ_CREDITS}/grant-credits`, { credits: 25 });
      expect(res.status).toBe(201);
      const ledger = await prisma.creditLedger.findUniqueOrThrow({
        where: { businessId: BIZ_CREDITS },
      });
      expect(ledger.balance).toBe(80);
      expect(await auditCount('grant-credits', BIZ_CREDITS)).toBe(2);
    });

    it('creates the ledger from the plan grant when the business has none yet', async () => {
      const res = await post(`/admin/businesses/${BIZ_PLAN}/grant-credits`, { credits: 10 });
      expect(res.status).toBe(201);
      const plan = await prisma.plan.findUniqueOrThrow({ where: { id: 'starter' } });
      const ledger = await prisma.creditLedger.findUniqueOrThrow({
        where: { businessId: BIZ_PLAN },
      });
      expect(ledger.balance).toBe(plan.creditsPerMonth + 10);

      const entry = await lastAudit('grant-credits', BIZ_PLAN);
      expect(entry!.before).toEqual({ balance: null });
      expect(entry!.note).toBe('Ledger was created by this grant');
    });

    it('rejects zero, negative and fractional grants -> 422 VALIDATION_ERROR', async () => {
      for (const body of [{ credits: 0 }, { credits: -5 }, { credits: 1.5 }, {}]) {
        const res = await post(`/admin/businesses/${BIZ_CREDITS}/grant-credits`, body);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      const ledger = await prisma.creditLedger.findUniqueOrThrow({
        where: { businessId: BIZ_CREDITS },
      });
      expect(ledger.balance).toBe(80);
    });

    it('unknown id -> 404 NOT_FOUND', async () => {
      const res = await post(`/admin/businesses/${uuidv7()}/grant-credits`, { credits: 5 });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /admin/businesses/:id/force-plan
  // ---------------------------------------------------------------------------

  describe('POST /admin/businesses/:id/force-plan', () => {
    it('moves Business.plan and Subscription in lockstep, creating the subscription', async () => {
      expect(await prisma.subscription.findUnique({ where: { businessId: BIZ_PLAN } })).toBeNull();

      const res = await post(`/admin/businesses/${BIZ_PLAN}/force-plan`, { plan: 'wholesale' });
      expect(res.status).toBe(201);
      expect(res.body.plan).toBe('wholesale');
      expect(res.body.subscriptionState).toBe('active');

      const business = await prisma.business.findUniqueOrThrow({ where: { id: BIZ_PLAN } });
      const subscription = await prisma.subscription.findUniqueOrThrow({
        where: { businessId: BIZ_PLAN },
      });
      expect(business.plan).toBe('wholesale');
      expect(subscription.planId).toBe('wholesale');
      expect(subscription.activePlanId).toBe('wholesale');
      expect(subscription.entitlementState).toBe('active');

      const entry = await lastAudit('force-plan', BIZ_PLAN);
      expect(entry!.before).toEqual({
        plan: 'starter',
        subscriptionState: null,
        activePlanId: null,
      });
      expect(entry!.after).toEqual({
        plan: 'wholesale',
        subscriptionState: 'active',
        activePlanId: 'wholesale',
      });
      expect(entry!.note).toContain('store-driven IAP lifecycle event can overwrite it');
    });

    it('updates an existing subscription and is safe to re-run', async () => {
      const res = await post(`/admin/businesses/${BIZ_PLAN}/force-plan`, { plan: 'wholesale' });
      expect(res.status).toBe(201);
      expect(await prisma.subscription.count({ where: { businessId: BIZ_PLAN } })).toBe(1);

      const again = await post(`/admin/businesses/${BIZ_PLAN}/force-plan`, { plan: 'business' });
      expect(again.status).toBe(201);
      const subscription = await prisma.subscription.findUniqueOrThrow({
        where: { businessId: BIZ_PLAN },
      });
      expect(subscription.activePlanId).toBe('business');
      expect(
        (await prisma.business.findUniqueOrThrow({ where: { id: BIZ_PLAN } })).plan,
      ).toBe('business');
    });

    it('writes NO BillingTransaction row (never consumes a trader bundle cap)', async () => {
      expect(await prisma.billingTransaction.count({ where: { businessId: BIZ_PLAN } })).toBe(0);
    });

    it('unknown plan -> 422 VALIDATION_ERROR with no state change', async () => {
      for (const body of [{ plan: 'pro' }, { plan: '' }, {}]) {
        const res = await post(`/admin/businesses/${BIZ_PLAN}/force-plan`, body);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      expect((await prisma.business.findUniqueOrThrow({ where: { id: BIZ_PLAN } })).plan).toBe(
        'business',
      );
    });

    it('unknown id -> 404 NOT_FOUND', async () => {
      const res = await post(`/admin/businesses/${uuidv7()}/force-plan`, { plan: 'market' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /admin/businesses/:id/enterprise-bands
  // ---------------------------------------------------------------------------

  describe('POST /admin/businesses/:id/enterprise-bands', () => {
    let baseCeiling: number;

    beforeAll(async () => {
      const plan = await prisma.plan.findUniqueOrThrow({ where: { id: 'enterprise' } });
      baseCeiling = Number(plan.bvumCeiling);
      expect(baseCeiling).toBe(40_000_000 * 100); // N40M base, in kobo
      expect(ENTERPRISE_BAND_CEILING_KOBO).toBe(20_000_000 * 100); // +N20M per band
    });

    it('writes the band count AND the derived bvumCeilingOverride in kobo', async () => {
      const res = await post(`/admin/businesses/${BIZ_ENTERPRISE}/enterprise-bands`, {
        extraBands: 2,
      });
      expect(res.status).toBe(201);
      expect(res.body.extraBands).toBe(2);
      expect(res.body.baseCeilingKobo).toBe(baseCeiling);
      expect(res.body.effectiveCeilingKobo).toBe(baseCeiling + 2 * ENTERPRISE_BAND_CEILING_KOBO);

      const row = await prisma.business.findUniqueOrThrow({ where: { id: BIZ_ENTERPRISE } });
      expect(row.enterpriseBands).toBe(2);
      expect(Number(row.bvumCeilingOverride)).toBe(8_000_000_000);

      const entry = await lastAudit('enterprise-bands', BIZ_ENTERPRISE);
      expect(entry!.before).toEqual({ extraBands: 0, bvumCeilingOverrideKobo: null });
      expect(entry!.after).toEqual({
        extraBands: 2,
        bvumCeilingOverrideKobo: 8_000_000_000,
        baseCeilingKobo: baseCeiling,
      });
    });

    it('re-runs to the same ceiling (recomputed, never accumulated)', async () => {
      await post(`/admin/businesses/${BIZ_ENTERPRISE}/enterprise-bands`, { extraBands: 2 });
      const row = await prisma.business.findUniqueOrThrow({ where: { id: BIZ_ENTERPRISE } });
      expect(row.enterpriseBands).toBe(2);
      expect(Number(row.bvumCeilingOverride)).toBe(8_000_000_000);
    });

    it('extraBands 0 returns the override to the plain enterprise base', async () => {
      const res = await post(`/admin/businesses/${BIZ_ENTERPRISE}/enterprise-bands`, {
        extraBands: 0,
      });
      expect(res.status).toBe(201);
      expect(res.body.effectiveCeilingKobo).toBe(baseCeiling);
      const row = await prisma.business.findUniqueOrThrow({ where: { id: BIZ_ENTERPRISE } });
      expect(Number(row.bvumCeilingOverride)).toBe(baseCeiling);

      // Restore the banded provisioning for the remaining assertions.
      await post(`/admin/businesses/${BIZ_ENTERPRISE}/enterprise-bands`, { extraBands: 1 });
      const banded = await prisma.business.findUniqueOrThrow({ where: { id: BIZ_ENTERPRISE } });
      expect(Number(banded.bvumCeilingOverride)).toBe(6_000_000_000);
    });

    it('refuses on a non-enterprise plan -> 422 VALIDATION_ERROR, nothing written', async () => {
      const res = await post(`/admin/businesses/${BIZ_SUSPEND}/enterprise-bands`, {
        extraBands: 3,
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');

      const row = await prisma.business.findUniqueOrThrow({ where: { id: BIZ_SUSPEND } });
      expect(row.enterpriseBands).toBe(0);
      expect(row.bvumCeilingOverride).toBeNull();
      expect(await auditCount('enterprise-bands', BIZ_SUSPEND)).toBe(0);
    });

    it('rejects negative or fractional bands -> 422 VALIDATION_ERROR', async () => {
      for (const body of [{ extraBands: -1 }, { extraBands: 0.5 }, {}]) {
        const res = await post(`/admin/businesses/${BIZ_ENTERPRISE}/enterprise-bands`, body);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('unknown id -> 404 NOT_FOUND', async () => {
      const res = await post(`/admin/businesses/${uuidv7()}/enterprise-bands`, { extraBands: 1 });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /admin/businesses/:id/suspend + /unsuspend
  // ---------------------------------------------------------------------------

  describe('POST /admin/businesses/:id/suspend + unsuspend', () => {
    it('suspend stamps suspendedAt and audits the note', async () => {
      const res = await post(`/admin/businesses/${BIZ_SUSPEND}/suspend`, {
        note: 'Chargeback investigation',
      });
      expect(res.status).toBe(201);
      expect(typeof res.body.suspendedAt).toBe('string');

      const row = await prisma.business.findUniqueOrThrow({ where: { id: BIZ_SUSPEND } });
      expect(row.suspendedAt).not.toBeNull();

      const entry = await lastAudit('suspend', BIZ_SUSPEND);
      expect(entry!.before).toEqual({ suspendedAt: null });
      expect(entry!.after).toEqual({ suspendedAt: row.suspendedAt!.toISOString() });
      expect(entry!.note).toBe('Chargeback investigation');
    });

    it('suspending twice -> 422 VALIDATION_ERROR and the date is never re-stamped', async () => {
      const before = await prisma.business.findUniqueOrThrow({ where: { id: BIZ_SUSPEND } });
      const res = await post(`/admin/businesses/${BIZ_SUSPEND}/suspend`, {});
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');

      const after = await prisma.business.findUniqueOrThrow({ where: { id: BIZ_SUSPEND } });
      expect(after.suspendedAt!.toISOString()).toBe(before.suspendedAt!.toISOString());
      expect(await auditCount('suspend', BIZ_SUSPEND)).toBe(1);
    });

    it('suspension records state only: debts and payments are untouched', async () => {
      // Enforcement lives in the protected debts service (followup-suspension-enforcement);
      // this endpoint must not have taken any collection-side action.
      expect(await prisma.debt.count({ where: { businessId: BIZ_SUSPEND } })).toBe(0);
      const row = await prisma.business.findUniqueOrThrow({ where: { id: BIZ_SUSPEND } });
      expect(row.plan).toBe('market');
    });

    it('unsuspend clears suspendedAt and audits it', async () => {
      const before = await prisma.business.findUniqueOrThrow({ where: { id: BIZ_SUSPEND } });
      const res = await post(`/admin/businesses/${BIZ_SUSPEND}/unsuspend`);
      expect(res.status).toBe(201);
      expect(res.body.suspendedAt).toBeNull();
      expect(
        (await prisma.business.findUniqueOrThrow({ where: { id: BIZ_SUSPEND } })).suspendedAt,
      ).toBeNull();

      const entry = await lastAudit('unsuspend', BIZ_SUSPEND);
      expect(entry!.before).toEqual({ suspendedAt: before.suspendedAt!.toISOString() });
      expect(entry!.after).toEqual({ suspendedAt: null });
    });

    it('unsuspending an active business -> 422 VALIDATION_ERROR', async () => {
      const res = await post(`/admin/businesses/${BIZ_SUSPEND}/unsuspend`);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(await auditCount('unsuspend', BIZ_SUSPEND)).toBe(1);
    });

    it('the suspend/unsuspend cycle is re-runnable', async () => {
      expect((await post(`/admin/businesses/${BIZ_SUSPEND}/suspend`)).status).toBe(201);
      expect((await post(`/admin/businesses/${BIZ_SUSPEND}/unsuspend`)).status).toBe(201);
      expect(
        (await prisma.business.findUniqueOrThrow({ where: { id: BIZ_SUSPEND } })).suspendedAt,
      ).toBeNull();
    });

    it('unknown id -> 404 NOT_FOUND on both routes', async () => {
      const id = uuidv7();
      for (const path of [`/admin/businesses/${id}/suspend`, `/admin/businesses/${id}/unsuspend`]) {
        const res = await post(path);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // POST /admin/businesses/:id/reset-test
  // ---------------------------------------------------------------------------

  describe('POST /admin/businesses/:id/reset-test', () => {
    it('REFUSES on a business that is not test-flagged -> 403 FORBIDDEN, nothing wiped', async () => {
      const before = await domainCounts(BIZ_NEIGHBOUR);
      await prisma.business.update({ where: { id: BIZ_NEIGHBOUR }, data: { isTest: false } });

      const res = await post(`/admin/businesses/${BIZ_NEIGHBOUR}/reset-test`, {
        confirm: NEIGHBOUR_NAME,
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(await domainCounts(BIZ_NEIGHBOUR)).toEqual(before);
      expect(await auditCount('reset-test-business', BIZ_NEIGHBOUR)).toBe(0);

      await prisma.business.update({ where: { id: BIZ_NEIGHBOUR }, data: { isTest: true } });
    });

    it('refuses a confirm mismatch -> 422 VALIDATION_ERROR, nothing wiped', async () => {
      const before = await domainCounts(BIZ_RESET);
      for (const body of [{ confirm: 'wrong name' }, { confirm: RESET_NAME.toLowerCase() }, {}]) {
        const res = await post(`/admin/businesses/${BIZ_RESET}/reset-test`, body);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      expect(await domainCounts(BIZ_RESET)).toEqual(before);
      expect(await auditCount('reset-test-business', BIZ_RESET)).toBe(0);
    });

    it('wipes the test business own rows, keeps the tenant row, and audits the counts', async () => {
      await prisma.creditLedger.upsert({
        where: { businessId: BIZ_RESET },
        create: {
          businessId: BIZ_RESET,
          balance: 999,
          monthlyGrant: 10,
          periodStart: currentPeriodStart(),
        },
        update: { balance: 999, monthlyGrant: 10 },
      });

      const res = await post(`/admin/businesses/${BIZ_RESET}/reset-test`, { confirm: RESET_NAME });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true, cleared: { debts: 1, payments: 1, reminders: 1 } });

      expect(await domainCounts(BIZ_RESET)).toEqual({
        customers: 0,
        debts: 0,
        payments: 0,
        reminders: 0,
        notifications: 0,
        usageEvents: 0,
      });

      // The tenant root itself is NEVER deleted (no delete path for Business anywhere).
      const business = await prisma.business.findUniqueOrThrow({ where: { id: BIZ_RESET } });
      expect(business.businessName).toBe(RESET_NAME);
      expect(business.isTest).toBe(true);

      // Ledger reset to the plan grant with the bonus removed.
      const plan = await prisma.plan.findUniqueOrThrow({ where: { id: 'market' } });
      const ledger = await prisma.creditLedger.findUniqueOrThrow({
        where: { businessId: BIZ_RESET },
      });
      expect(ledger.balance).toBe(plan.creditsPerMonth);
      expect(ledger.monthlyGrant).toBe(plan.creditsPerMonth);

      const entry = await lastAudit('reset-test-business', BIZ_RESET);
      expect(entry!.before).toEqual({ isTest: true, confirmed: RESET_NAME });
      expect(entry!.after).toEqual({
        cleared: {
          debts: 1,
          payments: 1,
          reminders: 1,
          customers: 1,
          notifications: 1,
          usageEvents: 1,
        },
        creditLedgerResetTo: plan.creditsPerMonth,
      });
    });

    it('NEVER touches another tenant (the neighbour test business is intact)', async () => {
      expect(await domainCounts(BIZ_NEIGHBOUR)).toEqual({
        customers: 1,
        debts: 1,
        payments: 1,
        reminders: 1,
        notifications: 1,
        usageEvents: 1,
      });
      // And no other tenant lost rows either.
      expect(await prisma.business.count()).toBe(7);
    });

    it('is safe to re-run: reports zeros, stays ok, leaves the neighbour alone', async () => {
      const res = await post(`/admin/businesses/${BIZ_RESET}/reset-test`, { confirm: RESET_NAME });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true, cleared: { debts: 0, payments: 0, reminders: 0 } });
      expect(await auditCount('reset-test-business', BIZ_RESET)).toBe(2);
      expect((await domainCounts(BIZ_NEIGHBOUR)).debts).toBe(1);
    });

    it('unknown id -> 404 NOT_FOUND', async () => {
      const res = await post(`/admin/businesses/${uuidv7()}/reset-test`, { confirm: 'x' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------------
  // Audit completeness
  // ---------------------------------------------------------------------------

  describe('audit completeness', () => {
    it('every action type reached the ONE audit writer with an actor snapshot', async () => {
      const types = await prisma.adminAuditLog.groupBy({ by: ['actionType'] });
      const seen = types.map((t) => t.actionType);
      for (const type of [
        'test-flag',
        'grant-credits',
        'force-plan',
        'enterprise-bands',
        'suspend',
        'unsuspend',
        'reset-test-business',
      ]) {
        expect(seen).toContain(type);
      }

      const rows = await prisma.adminAuditLog.findMany({
        where: { targetType: 'Business' },
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.adminUserId).toBe(rootAdminId);
        expect(row.adminNameSnapshot).toBe('Actions Root');
        expect(row.adminRoleSnapshot).toBe('superadmin');
        expect(row.targetBusinessId).toBe(row.targetId);
        expect(row.action.startsWith('Actions Root ')).toBe(true);
      }
    });
  });
});
