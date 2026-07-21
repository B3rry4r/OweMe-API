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
import { BvumService } from '../../../bvum/bvum.service';
import { MONTHLY_BUNDLE_CAP } from '../../../billing/bundle-catalog';
import { currentPeriodStart } from '../../../usage/period.util';
import { AdminModule } from '../../admin.module';
import { hashPassword } from '../../common';
import { AdminBusinessesModule } from '../admin-businesses.module';

// Admin secrets are env-driven with no insecure fallback; specs boot with explicit
// test values, mirroring how test/setenv.ts boots the user-auth specs.
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET ?? 'test-admin-access-secret';
process.env.ADMIN_JWT_REFRESH_SECRET =
  process.env.ADMIN_JWT_REFRESH_SECRET ?? 'test-admin-refresh-secret';

/**
 * AdminBusinessesView (contract). Same boot as app.module (global user guards,
 * ValidationPipe, HttpExceptionFilter) + AdminModule (for admin login) + this
 * resource's module, which the integrator later aggregates into AdminModule.
 *
 * Covers: auth required and user-token cross-rejection, the support role gate, the
 * four endpoint shapes over seeded data, derived status/plan/credit/BVUM figures,
 * search + plan + status filters, offset pagination, 404s, and the empty-table
 * behaviour of the new usage_events reader.
 */
describe('AdminBusinessesView (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let bvum: BvumService;

  const ROOT_EMAIL = 'root-businesses@oweme.app';
  const ROOT_PASSWORD = 'RootPass!2026';
  const SUPPORT_EMAIL = 'support-businesses@oweme.app';
  const SUPPORT_PASSWORD = 'SupportPass!1';
  let rootAccess: string;
  let supportAccess: string;

  // Distinctive tenant ids so this suite never collides with other waves' seeded rows.
  const BIZ_STARTER = '01919aaa-bbbb-7ccc-8ddd-adminbiz0start';
  const BIZ_SUSPENDED = '01919aaa-bbbb-7ccc-8ddd-adminbiz0susp0';
  const BIZ_TEST = '01919aaa-bbbb-7ccc-8ddd-adminbiz00test';
  const BIZ_ENTERPRISE = '01919aaa-bbbb-7ccc-8ddd-adminbiz00ent0';

  const PHONE_STARTER = '2348031112222';
  const PHONE_SUSPENDED = '2348022223333';
  const PHONE_TEST = '2348099998888';
  const PHONE_ENTERPRISE = '2348077776666';

  const CUSTOMER_A = uuidv7();
  const CUSTOMER_B = uuidv7();
  const DEBT_OPEN = uuidv7();
  const DEBT_PARTIAL = uuidv7();
  const DEBT_PAID = uuidv7();
  const DEBT_OVERDUE = uuidv7();
  const DEBT_ARCHIVED = uuidv7();

  const login = async (email: string, password: string) =>
    request(app.getHttpServer()).post('/admin/auth/login').send({ email, password });

  const list = async (query: Record<string, string | number> = {}, token: string = rootAccess) =>
    request(app.getHttpServer())
      .get('/admin/businesses')
      .query(query)
      .set('Authorization', `Bearer ${token}`);

  const get = async (path: string, token: string = rootAccess) =>
    request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);

  const rowFor = (body: { data: Record<string, unknown>[] }, id: string) =>
    body.data.find((b) => b.id === id) as Record<string, unknown>;

  const expectBusinessShape = (b: Record<string, unknown>): void => {
    expect(typeof b.id).toBe('string');
    expect(typeof b.name).toBe('string');
    expect(typeof b.ownerPhoneMasked).toBe('string');
    expect(['starter', 'market', 'business', 'wholesale', 'enterprise']).toContain(b.plan);
    expect(['active', 'suspended', 'test']).toContain(b.status);
    expect(typeof b.isTest).toBe('boolean');
    expect(b.suspendedAt === null || typeof b.suspendedAt === 'string').toBe(true);
    expect(typeof b.bvumKobo).toBe('number');
    expect(typeof b.ceilingKobo).toBe('number');
    expect(b.creditsUsed === null || typeof b.creditsUsed === 'number').toBe(true);
    expect(b.creditsGrant === null || typeof b.creditsGrant === 'number').toBe(true);
    expect(typeof b.staffCount).toBe('number');
    expect(new Date(b.joinedAt as string).toISOString()).toBe(b.joinedAt);
  };

  const seedBusiness = async (
    id: string,
    businessName: string,
    phone: string,
    plan: string,
    createdAt: Date,
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
        createdAt,
        ...extra,
      },
    });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // AdminBusinessesModule is imported explicitly: the integrator aggregates it into
      // AdminModule after this wave, so the spec must not depend on that edit landing.
      imports: [PrismaModule, CommonModule, AdminModule, AdminBusinessesModule],
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
    bvum = app.get(BvumService);
    await app.init();

    // Admins.
    await prisma.adminAuditLog.deleteMany({});
    await prisma.adminRefreshToken.deleteMany({});
    await prisma.adminUser.deleteMany({});
    for (const [email, name, role, password] of [
      [ROOT_EMAIL, 'Businesses Root', 'superadmin', ROOT_PASSWORD],
      [SUPPORT_EMAIL, 'Businesses Support', 'support', SUPPORT_PASSWORD],
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

    // The admin table is platform-wide, so the fixture set must be the whole table.
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

    await seedBusiness(
      BIZ_STARTER,
      'Mama Nkechi Provisions',
      PHONE_STARTER,
      'starter',
      new Date('2026-01-10T09:00:00.000Z'),
    );
    await seedBusiness(
      BIZ_SUSPENDED,
      'Okoro Electronics',
      PHONE_SUSPENDED,
      'business',
      new Date('2026-02-10T09:00:00.000Z'),
      { suspendedAt: new Date('2026-06-01T00:00:00.000Z') },
    );
    await seedBusiness(
      BIZ_TEST,
      'Sandbox Kitchen',
      PHONE_TEST,
      'market',
      new Date('2026-03-10T09:00:00.000Z'),
      { isTest: true },
    );
    await seedBusiness(
      BIZ_ENTERPRISE,
      'Wholesale Depot',
      PHONE_ENTERPRISE,
      'enterprise',
      new Date('2026-04-10T09:00:00.000Z'),
      { enterpriseBands: 2, bvumCeilingOverride: BigInt(8_000_000_000) },
    );

    // Starter: a ledger mid-period (grant 50, balance 30 -> 20 used) and one open debt.
    await prisma.creditLedger.create({
      data: {
        businessId: BIZ_STARTER,
        balance: 30,
        monthlyGrant: 50,
        periodStart: currentPeriodStart(),
      },
    });
    await prisma.customer.create({
      data: { id: CUSTOMER_A, businessId: BIZ_STARTER, name: 'Adaeze Umeh', phone: '08031112222' },
    });
    await prisma.customer.create({
      data: { id: CUSTOMER_B, businessId: BIZ_STARTER, name: 'Bola', phone: '08031113333' },
    });
    await prisma.debt.create({
      data: {
        id: DEBT_OPEN,
        businessId: BIZ_STARTER,
        customerId: CUSTOMER_A,
        amount: 100_000,
        createdAt: new Date('2026-07-01T09:00:00.000Z'),
      },
    });
    await prisma.debt.create({
      data: {
        id: DEBT_PARTIAL,
        businessId: BIZ_STARTER,
        customerId: CUSTOMER_A,
        amount: 200_000,
        createdAt: new Date('2026-07-02T09:00:00.000Z'),
        dueDate: new Date('2027-01-01T09:00:00.000Z'),
      },
    });
    await prisma.debt.create({
      data: {
        id: DEBT_PAID,
        businessId: BIZ_STARTER,
        customerId: CUSTOMER_B,
        amount: 50_000,
        createdAt: new Date('2026-07-03T09:00:00.000Z'),
      },
    });
    await prisma.debt.create({
      data: {
        id: DEBT_OVERDUE,
        businessId: BIZ_STARTER,
        customerId: CUSTOMER_B,
        amount: 70_000,
        createdAt: new Date('2026-07-04T09:00:00.000Z'),
        dueDate: new Date('2026-01-01T09:00:00.000Z'),
      },
    });
    await prisma.debt.create({
      data: {
        id: DEBT_ARCHIVED,
        businessId: BIZ_STARTER,
        customerId: CUSTOMER_B,
        amount: 10_000,
        createdAt: new Date('2026-07-05T09:00:00.000Z'),
        deleted: true,
      },
    });
    await prisma.payment.create({
      data: {
        id: uuidv7(),
        businessId: BIZ_STARTER,
        debtId: DEBT_PARTIAL,
        amount: 60_000,
        method: 'Cash',
        reference: 'OWM-00001',
      },
    });
    await prisma.payment.create({
      data: {
        id: uuidv7(),
        businessId: BIZ_STARTER,
        debtId: DEBT_PAID,
        amount: 50_000,
        method: 'Cash',
        reference: 'OWM-00002',
      },
    });

    // Enterprise: fair-use ledger, an active subscription, staff seats, a bundle purchase.
    await prisma.creditLedger.create({
      data: {
        businessId: BIZ_ENTERPRISE,
        balance: 0,
        monthlyGrant: -1,
        periodStart: currentPeriodStart(),
      },
    });
    await prisma.subscription.create({
      data: {
        businessId: BIZ_ENTERPRISE,
        planId: 'enterprise',
        entitlementState: 'active',
        activePlanId: 'enterprise',
        renewalAt: new Date('2026-08-10T09:00:00.000Z'),
      },
    });
    for (const [name, phone, role, active] of [
      ['Owner Ada', '08077776666', 'owner', true],
      ['Staff One', '08077776667', 'staff', true],
      ['Staff Two', '08077776668', 'staff', true],
      ['Staff Gone', '08077776669', 'staff', false],
    ] as [string, string, string, boolean][]) {
      await prisma.staff.create({
        data: { id: uuidv7(), businessId: BIZ_ENTERPRISE, name, phone, role, active },
      });
    }
    await prisma.billingTransaction.create({
      data: {
        id: uuidv7(),
        businessId: BIZ_ENTERPRISE,
        kind: 'credits-bundle',
        productId: 'oweme_credits_600',
        label: '600 OweMe credits',
        amount: 400_000,
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('auth + role gate', () => {
    const paths = [
      '/admin/businesses',
      `/admin/businesses/${BIZ_STARTER}`,
      `/admin/businesses/${BIZ_STARTER}/credit-usage`,
      `/admin/businesses/${BIZ_STARTER}/debts`,
    ];

    it('no token -> 401 UNAUTHENTICATED on every endpoint', async () => {
      for (const path of paths) {
        const res = await request(app.getHttpServer()).get(path);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('a USER token is rejected on the admin surface -> 401', async () => {
      const userToken = jwt.sign(
        { sub: 'user-owner', businessId: BIZ_STARTER, role: 'owner' },
        { secret: process.env.JWT_ACCESS_SECRET ?? 'test-access-secret', expiresIn: '1h' },
      );
      for (const path of paths) {
        const res = await request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${userToken}`);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
      const garbage = await request(app.getHttpServer())
        .get('/admin/businesses')
        .set('Authorization', 'Bearer not-a-token');
      expect(garbage.status).toBe(401);
    });

    it('support may read every endpoint (registry adminRoles)', async () => {
      for (const path of paths) {
        const res = await get(path, supportAccess);
        expect(res.status).toBe(200);
      }
    });
  });

  describe('GET /admin/businesses', () => {
    it('returns Paged<AdminBusinessView>, newest first, with derived status', async () => {
      const res = await list();
      expect(res.status).toBe(200);
      expect(res.body.page).toBe(1);
      expect(res.body.total).toBe(4);
      expect(res.body.data).toHaveLength(4);
      for (const b of res.body.data) expectBusinessShape(b);

      expect(res.body.data.map((b: Record<string, unknown>) => b.id)).toEqual([
        BIZ_ENTERPRISE,
        BIZ_TEST,
        BIZ_SUSPENDED,
        BIZ_STARTER,
      ]);

      expect(rowFor(res.body, BIZ_STARTER).status).toBe('active');
      expect(rowFor(res.body, BIZ_SUSPENDED).status).toBe('suspended');
      expect(rowFor(res.body, BIZ_SUSPENDED).suspendedAt).toBe('2026-06-01T00:00:00.000Z');
      // isTest wins over suspendedAt in the derivation order.
      expect(rowFor(res.body, BIZ_TEST).status).toBe('test');
      expect(rowFor(res.body, BIZ_TEST).isTest).toBe(true);
    });

    it('masks the owner phone to the last 4 digits', async () => {
      const res = await list();
      const masked = rowFor(res.body, BIZ_STARTER).ownerPhoneMasked as string;
      expect(masked).toBe(`${'*'.repeat(PHONE_STARTER.length - 4)}${PHONE_STARTER.slice(-4)}`);
      expect(masked).not.toContain(PHONE_STARTER.slice(0, 4));
      expect(masked.endsWith(PHONE_STARTER.slice(-4))).toBe(true);
    });

    it('bvumKobo + ceilingKobo match the live BvumService definition', async () => {
      const snapshot = await bvum.compute(BIZ_STARTER);
      const res = await list();
      const row = rowFor(res.body, BIZ_STARTER);
      expect(row.bvumKobo).toBe(snapshot.value);
      expect(row.bvumKobo).toBeGreaterThan(0);
      expect(row.ceilingKobo).toBe(snapshot.ceiling);

      // Enterprise banding: the sales-provisioned override is the effective ceiling.
      expect(rowFor(res.body, BIZ_ENTERPRISE).ceilingKobo).toBe(8_000_000_000);
    });

    it('derives credits from the raw ledger and never refills it as a side effect', async () => {
      const before = await prisma.creditLedger.findUnique({ where: { businessId: BIZ_STARTER } });
      const res = await list();

      const starter = rowFor(res.body, BIZ_STARTER);
      expect(starter.creditsGrant).toBe(50);
      expect(starter.creditsUsed).toBe(20);

      // No ledger row yet -> the plan grant, nothing used.
      const plan = await prisma.plan.findUnique({ where: { id: 'business' } });
      expect(rowFor(res.body, BIZ_SUSPENDED).creditsGrant).toBe(plan!.creditsPerMonth);
      expect(rowFor(res.body, BIZ_SUSPENDED).creditsUsed).toBe(0);

      // Fair use (grant -1) reports null on both sides of the meter.
      expect(rowFor(res.body, BIZ_ENTERPRISE).creditsGrant).toBeNull();
      expect(rowFor(res.body, BIZ_ENTERPRISE).creditsUsed).toBeNull();

      const after = await prisma.creditLedger.findUnique({ where: { businessId: BIZ_STARTER } });
      expect(after).toEqual(before);
      expect(await prisma.creditLedger.count()).toBe(2);
    });

    it('counts occupied staff seats (non-owner, active)', async () => {
      const res = await list();
      expect(rowFor(res.body, BIZ_ENTERPRISE).staffCount).toBe(2);
      expect(rowFor(res.body, BIZ_STARTER).staffCount).toBe(0);
    });

    it('filters by search (name or phone contains)', async () => {
      const byName = await list({ search: 'Okoro' });
      expect(byName.status).toBe(200);
      expect(byName.body.total).toBe(1);
      expect(byName.body.data[0].id).toBe(BIZ_SUSPENDED);

      const byPhone = await list({ search: PHONE_ENTERPRISE.slice(-6) });
      expect(byPhone.body.total).toBe(1);
      expect(byPhone.body.data[0].id).toBe(BIZ_ENTERPRISE);

      const none = await list({ search: 'No Such Shop' });
      expect(none.body).toEqual({ data: [], page: 1, total: 0 });
    });

    it('filters by plan', async () => {
      const res = await list({ plan: 'enterprise' });
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0].id).toBe(BIZ_ENTERPRISE);

      const wholesale = await list({ plan: 'wholesale' });
      expect(wholesale.body.total).toBe(0);
    });

    it('filters by derived status', async () => {
      const active = await list({ status: 'active' });
      expect(active.body.data.map((b: Record<string, unknown>) => b.id).sort()).toEqual(
        [BIZ_STARTER, BIZ_ENTERPRISE].sort(),
      );

      const suspended = await list({ status: 'suspended' });
      expect(suspended.body.total).toBe(1);
      expect(suspended.body.data[0].id).toBe(BIZ_SUSPENDED);

      const test = await list({ status: 'test' });
      expect(test.body.total).toBe(1);
      expect(test.body.data[0].id).toBe(BIZ_TEST);
    });

    it('paginates by offset with a stable order', async () => {
      const page1 = await list({ page: 1, limit: 3 });
      expect(page1.body.data).toHaveLength(3);
      expect(page1.body.total).toBe(4);

      const page2 = await list({ page: 2, limit: 3 });
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.page).toBe(2);
      expect(page2.body.total).toBe(4);
      expect(page2.body.data[0].id).toBe(BIZ_STARTER);

      const page1Ids = page1.body.data.map((b: Record<string, unknown>) => b.id);
      expect(page1Ids).not.toContain(BIZ_STARTER);
    });

    it('rejects out-of-range paging and unknown enum values -> 422 VALIDATION_ERROR', async () => {
      const badQueries: Record<string, string | number>[] = [
        { limit: 0 },
        { limit: 101 },
        { page: 0 },
        { plan: 'pro' },
        { status: 'paused' },
        { unknown: 'x' },
      ];
      for (const query of badQueries) {
        const res = await list(query);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('GET /admin/businesses/:id', () => {
    it('returns the detail header with live entitlement vocabulary', async () => {
      const res = await get(`/admin/businesses/${BIZ_ENTERPRISE}`);
      expect(res.status).toBe(200);
      const plan = await prisma.plan.findUnique({ where: { id: 'enterprise' } });

      expect(res.body.id).toBe(BIZ_ENTERPRISE);
      expect(res.body.name).toBe('Wholesale Depot');
      expect(res.body.plan).toBe('enterprise');
      expect(res.body.isTest).toBe(false);
      expect(res.body.suspendedAt).toBeNull();
      expect(res.body.ownerPhoneMasked.endsWith(PHONE_ENTERPRISE.slice(-4))).toBe(true);
      expect(res.body.joinedAt).toBe('2026-04-10T09:00:00.000Z');
      expect(res.body.staffSeatsUsed).toBe(2);
      expect(res.body.staffSeatsTotal).toBe(plan!.staffSeats);
      expect(['none', 'pending', 'active', 'gracePeriod', 'expired']).toContain(
        res.body.subscriptionState,
      );
      expect(res.body.subscriptionState).toBe('active');
      expect(res.body.renewalAt).toBe('2026-08-10T09:00:00.000Z');
      expect(res.body.bvumKobo).toBe((await bvum.compute(BIZ_ENTERPRISE)).value);
      expect(res.body.baseCeilingKobo).toBe(Number(plan!.bvumCeiling));
      expect(res.body.extraBands).toBe(2);
      expect(res.body.effectiveCeilingKobo).toBe(8_000_000_000);
      expect(res.body.bundlesBoughtThisMonth).toBe(1);
      expect(res.body.bundleCapPerMonth).toBe(MONTHLY_BUNDLE_CAP);
    });

    it('a business with no subscription reads none / null renewal, base ceiling', async () => {
      const res = await get(`/admin/businesses/${BIZ_STARTER}`);
      expect(res.status).toBe(200);
      const plan = await prisma.plan.findUnique({ where: { id: 'starter' } });
      expect(res.body.subscriptionState).toBe('none');
      expect(res.body.renewalAt).toBeNull();
      expect(res.body.extraBands).toBe(0);
      expect(res.body.effectiveCeilingKobo).toBe(Number(plan!.bvumCeiling));
      expect(res.body.baseCeilingKobo).toBe(Number(plan!.bvumCeiling));
      expect(res.body.bundlesBoughtThisMonth).toBe(0);
      expect(res.body.staffSeatsUsed).toBe(0);
    });

    it('unknown id -> 404 NOT_FOUND', async () => {
      const res = await get(`/admin/businesses/${uuidv7()}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /admin/businesses/:id/credit-usage', () => {
    it('reads honest zeros from the empty usage_events table', async () => {
      expect(await prisma.usageEvent.count()).toBe(0);
      const res = await get(`/admin/businesses/${BIZ_STARTER}/credit-usage`);
      expect(res.status).toBe(200);
      expect(res.body.sends).toBe(0);
      expect(res.body.parses).toBe(0);
      expect(res.body.insights).toBe(0);
      // Aggregate meter still wires from the ledger derivation (50 grant - 30 balance).
      expect(res.body.usedCredits).toBe(20);
      expect(res.body.grant).toBe(50);
      expect(res.body.bonusCredits).toBe(0);
      expect(res.body.fairUse).toBe(false);
      expect(res.body.periodStart).toBe(currentPeriodStart().toISOString());
    });

    it('counts per-type events once usage_events has rows', async () => {
      for (const [type, credits] of [
        ['send', 5],
        ['send', 5],
        ['voiceParse', 1],
        ['insight', 4],
      ] as [string, number][]) {
        await prisma.usageEvent.create({
          data: { id: uuidv7(), businessId: BIZ_STARTER, type, credits },
        });
      }
      const res = await get(`/admin/businesses/${BIZ_STARTER}/credit-usage`);
      expect(res.status).toBe(200);
      expect(res.body.sends).toBe(2);
      expect(res.body.parses).toBe(1);
      expect(res.body.insights).toBe(1);
      // Ledger derivation stays authoritative for the aggregate meter.
      expect(res.body.usedCredits).toBe(20);
      await prisma.usageEvent.deleteMany({});
    });

    it('reports bonus credits above the grant with used clamped at 0', async () => {
      await prisma.creditLedger.update({
        where: { businessId: BIZ_STARTER },
        data: { balance: 130 },
      });
      const res = await get(`/admin/businesses/${BIZ_STARTER}/credit-usage`);
      expect(res.status).toBe(200);
      expect(res.body.bonusCredits).toBe(80);
      expect(res.body.usedCredits).toBe(0);
      await prisma.creditLedger.update({
        where: { businessId: BIZ_STARTER },
        data: { balance: 30 },
      });
    });

    it('fair use reports grant null, fairUse true, zero used with no events', async () => {
      const res = await get(`/admin/businesses/${BIZ_ENTERPRISE}/credit-usage`);
      expect(res.status).toBe(200);
      expect(res.body.grant).toBeNull();
      expect(res.body.fairUse).toBe(true);
      expect(res.body.usedCredits).toBe(0);
      expect(res.body.bonusCredits).toBe(0);
    });

    it('a business with no ledger row falls back to the plan grant', async () => {
      const res = await get(`/admin/businesses/${BIZ_SUSPENDED}/credit-usage`);
      expect(res.status).toBe(200);
      const plan = await prisma.plan.findUnique({ where: { id: 'business' } });
      expect(res.body.grant).toBe(plan!.creditsPerMonth);
      expect(res.body.usedCredits).toBe(0);
      expect(res.body.periodStart).toBe(currentPeriodStart().toISOString());
      expect(await prisma.creditLedger.count()).toBe(2); // still not created by the read
    });

    it('unknown id -> 404 NOT_FOUND', async () => {
      const res = await get(`/admin/businesses/${uuidv7()}/credit-usage`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /admin/businesses/:id/debts', () => {
    it('returns Paged<AdminBusinessDebtView> newest first with derived status', async () => {
      const res = await get(`/admin/businesses/${BIZ_STARTER}/debts`);
      expect(res.status).toBe(200);
      expect(res.body.page).toBe(1);
      expect(res.body.total).toBe(5);
      expect(res.body.data).toHaveLength(5);

      const byId = new Map<string, Record<string, unknown>>(
        res.body.data.map((d: Record<string, unknown>) => [d.id as string, d]),
      );
      expect(byId.get(DEBT_ARCHIVED)!.status).toBe('archived');
      expect(byId.get(DEBT_PAID)!.status).toBe('paid');
      expect(byId.get(DEBT_PAID)!.remainingKobo).toBe(0);
      expect(byId.get(DEBT_OVERDUE)!.status).toBe('overdue');
      expect(byId.get(DEBT_PARTIAL)!.status).toBe('partial');
      expect(byId.get(DEBT_PARTIAL)!.amountKobo).toBe(200_000);
      expect(byId.get(DEBT_PARTIAL)!.remainingKobo).toBe(140_000);
      expect(byId.get(DEBT_OPEN)!.status).toBe('open');
      expect(byId.get(DEBT_OPEN)!.remainingKobo).toBe(100_000);

      // First name only, never the customer's full identity.
      expect(byId.get(DEBT_OPEN)!.customer).toBe('Adaeze');
      expect(byId.get(DEBT_PAID)!.customer).toBe('Bola');

      expect(res.body.data.map((d: Record<string, unknown>) => d.id)).toEqual([
        DEBT_ARCHIVED,
        DEBT_OVERDUE,
        DEBT_PAID,
        DEBT_PARTIAL,
        DEBT_OPEN,
      ]);
      for (const debt of res.body.data) {
        expect(new Date(debt.createdAt).toISOString()).toBe(debt.createdAt);
      }
    });

    it('paginates by offset (default limit 10, max 50)', async () => {
      const page1 = await get(`/admin/businesses/${BIZ_STARTER}/debts?page=1&limit=2`);
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.total).toBe(5);

      const page3 = await get(`/admin/businesses/${BIZ_STARTER}/debts?page=3&limit=2`);
      expect(page3.body.data).toHaveLength(1);
      expect(page3.body.page).toBe(3);

      const tooBig = await get(`/admin/businesses/${BIZ_STARTER}/debts?limit=51`);
      expect(tooBig.status).toBe(422);
      expect(tooBig.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('a business with no debts reads empty', async () => {
      const res = await get(`/admin/businesses/${BIZ_TEST}/debts`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [], page: 1, total: 0 });
    });

    it('unknown id -> 404 NOT_FOUND', async () => {
      const res = await get(`/admin/businesses/${uuidv7()}/debts`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('read-only invariant', () => {
    it('exposes no write route -> 404 NOT_FOUND', async () => {
      const attempts: ['post' | 'put' | 'patch' | 'delete', string][] = [
        ['post', '/admin/businesses'],
        ['put', `/admin/businesses/${BIZ_STARTER}`],
        ['patch', `/admin/businesses/${BIZ_STARTER}`],
        ['delete', `/admin/businesses/${BIZ_STARTER}`],
      ];
      for (const [method, path] of attempts) {
        const res = await request(app.getHttpServer())
          [method](path)
          .set('Authorization', `Bearer ${rootAccess}`);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
      expect(await prisma.business.count()).toBe(4);
      // Reading the monitor never writes an audit row (no mutation happened).
      expect(await prisma.adminAuditLog.count({ where: { targetBusinessId: BIZ_STARTER } })).toBe(0);
    });
  });
});
