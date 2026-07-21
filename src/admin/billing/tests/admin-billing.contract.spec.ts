import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { PrismaModule } from '../../../prisma/prisma.module';
import { PrismaService } from '../../../prisma/prisma.service';
import { CommonModule } from '../../../common/common.module';
import { HttpExceptionFilter } from '../../../common/filters/http-exception.filter';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { OTP_SENDER, OtpSender, uuidv7 } from '../../../common';
import { AuthModule } from '../../../auth/auth.module';
import { AdminModule } from '../../admin.module';
import { hashPassword } from '../../common';
import { AdminBillingModule } from '../admin-billing.module';

// Admin secrets are env-driven with no insecure fallback; specs boot with explicit
// test values, mirroring how test/setenv.ts boots the user-auth specs.
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET ?? 'test-admin-access-secret';
process.env.ADMIN_JWT_REFRESH_SECRET =
  process.env.ADMIN_JWT_REFRESH_SECRET ?? 'test-admin-refresh-secret';

/** Spy OtpSender so the spec can mint a REAL user session for the wrong-identity gate. */
class SpyOtpSender implements OtpSender {
  readonly codes = new Map<string, string>();
  async sendOtp(phone: string, code: string): Promise<void> {
    this.codes.set(phone, code);
  }
}

/**
 * AdminBillingView (contract). Same boot as app.module (global user guards,
 * ValidationPipe, HttpExceptionFilter) plus AdminModule (admin auth), the user
 * AuthModule (real user token for the identity gate) and this resource's module,
 * which AdminModule does not yet aggregate. Covers the superadmin-only role gate on
 * all four routes, the empty-table reads, the seeded shapes, filters and paging.
 */
describe('AdminBillingView (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sender = new SpyOtpSender();

  const ROOT_EMAIL = 'root-billing@oweme.app';
  const ROOT_PASSWORD = 'RootPass!2026';
  const SUPPORT_EMAIL = 'support-billing@oweme.app';
  const SUPPORT_PASSWORD = 'SupportPass!1';
  const USER_PHONE = '2348039990077';
  let rootAccess: string;
  let supportAccess: string;
  let userAccess: string;

  const BUSINESS_A = uuidv7(); // Mama Nkechi Provisions - active market subscription
  const BUSINESS_B = uuidv7(); // Okoro Electronics      - gracePeriod business
  const BUSINESS_C = uuidv7(); // Zuma Hardware          - expired starter

  const ROUTES = [
    '/admin/billing/subscriptions',
    '/admin/billing/transactions',
    '/admin/billing/stats',
    '/admin/billing/iap-lifecycle',
  ];

  const login = async (email: string, password: string) =>
    request(app.getHttpServer()).post('/admin/auth/login').send({ email, password });

  const get = async (
    path: string,
    query: Record<string, string | number> = {},
    token: string = rootAccess,
  ) =>
    request(app.getHttpServer())
      .get(path)
      .query(query)
      .set('Authorization', `Bearer ${token}`);

  const currentMonth = (): string => {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, AdminModule, AdminBillingModule, AuthModule],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideProvider(OTP_SENDER)
      .useValue(sender)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    prisma = app.get(PrismaService);
    await app.init();

    await prisma.adminAuditLog.deleteMany({});
    await prisma.adminRefreshToken.deleteMany({});
    await prisma.adminUser.deleteMany({});
    for (const [email, name, role, password] of [
      [ROOT_EMAIL, 'Billing Root', 'superadmin', ROOT_PASSWORD],
      [SUPPORT_EMAIL, 'Billing Support', 'support', SUPPORT_PASSWORD],
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

    // A REAL user session, to prove the app's identity is rejected on the admin surface.
    await request(app.getHttpServer()).post('/auth/request-otp').send({ phone: USER_PHONE });
    const verified = await request(app.getHttpServer())
      .post('/auth/verify-otp')
      .send({ phone: USER_PHONE, code: sender.codes.get(USER_PHONE)! });
    userAccess = verified.body.accessToken as string;

    // Start from genuinely empty billing tables (the user session seeded its own business).
    await prisma.billingTransaction.deleteMany({});
    await prisma.subscription.deleteMany({});
    await prisma.webhookEventLog.deleteMany({});
  });

  afterAll(async () => {
    await prisma.billingTransaction.deleteMany({});
    await prisma.subscription.deleteMany({});
    await prisma.webhookEventLog.deleteMany({});
    await prisma.business.deleteMany({ where: { id: { in: [BUSINESS_A, BUSINESS_B, BUSINESS_C] } } });
    await app.close();
  });

  describe('auth + role gate (superadmin only per registry)', () => {
    it('no token -> 401 on every route', async () => {
      for (const path of ROUTES) {
        const res = await request(app.getHttpServer()).get(path);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('garbage token and a valid USER token -> 401 on every route', async () => {
      for (const path of ROUTES) {
        const garbage = await request(app.getHttpServer())
          .get(path)
          .set('Authorization', 'Bearer not-a-token');
        expect(garbage.status).toBe(401);

        const asUser = await get(path, {}, userAccess);
        expect(asUser.status).toBe(401);
        expect(asUser.body.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('support -> 403 FORBIDDEN on every route; superadmin -> 200', async () => {
      for (const path of ROUTES) {
        const support = await get(path, {}, supportAccess);
        expect(support.status).toBe(403);
        expect(support.body.error.code).toBe('FORBIDDEN');

        const root = await get(path);
        expect(root.status).toBe(200);
      }
    });
  });

  describe('empty tables', () => {
    it('reads honestly from zero rows', async () => {
      const subs = await get('/admin/billing/subscriptions');
      expect(subs.body).toEqual({ data: [], page: 1, total: 0 });

      const txns = await get('/admin/billing/transactions');
      expect(txns.body).toEqual({ data: [], page: 1, total: 0 });

      const stats = await get('/admin/billing/stats');
      expect(stats.body).toEqual({
        activeSubscriptionCount: 0,
        graceSubscriptionCount: 0,
        mrrKobo: 0,
        storeFeeMonthKobo: null,
        failedRenewalsThisMonth: null,
      });

      const lifecycle = await get('/admin/billing/iap-lifecycle');
      expect(lifecycle.body).toEqual({
        entitlementStateCounts: { none: 0, pending: 0, active: 0, gracePeriod: 0, expired: 0 },
        events: { data: [], page: 1, total: 0 },
      });
    });
  });

  describe('seeded reads', () => {
    const RENEWAL = new Date('2026-08-15T00:00:00.000Z');
    let txnIds: string[];

    beforeAll(async () => {
      for (const [id, businessName] of [
        [BUSINESS_A, 'Mama Nkechi Provisions'],
        [BUSINESS_B, 'Okoro Electronics'],
        [BUSINESS_C, 'Zuma Hardware'],
      ]) {
        await prisma.business.create({
          data: {
            id,
            businessName,
            ownerName: 'Owner',
            phone: '2348000000000',
            category: 'Retail',
            currency: 'NGN (₦)',
            reminderTone: 'friendly',
          },
        });
      }

      await prisma.subscription.createMany({
        data: [
          {
            businessId: BUSINESS_A,
            planId: 'market',
            entitlementState: 'active',
            activePlanId: 'market',
            renewalAt: RENEWAL,
          },
          {
            businessId: BUSINESS_B,
            planId: 'business',
            entitlementState: 'gracePeriod',
            activePlanId: 'business',
            renewalAt: RENEWAL,
          },
          {
            businessId: BUSINESS_C,
            planId: 'market',
            entitlementState: 'expired',
            activePlanId: 'starter',
            renewalAt: null,
          },
        ],
      });

      const now = new Date();
      txnIds = [uuidv7(), uuidv7(), uuidv7()];
      await prisma.billingTransaction.createMany({
        data: [
          {
            id: txnIds[0],
            businessId: BUSINESS_A,
            kind: 'subscription',
            productId: 'oweme_market_monthly',
            label: 'Market plan',
            amount: 250_000,
            createdAt: now,
          },
          {
            id: txnIds[1],
            businessId: BUSINESS_B,
            kind: 'credits-bundle',
            productId: 'oweme_credits_600',
            label: '600 OweMe credits',
            // Webhook-recorded bundle row: recorded amount is 0, catalog price still resolves.
            amount: 0,
            createdAt: now,
          },
          {
            id: txnIds[2],
            businessId: BUSINESS_C,
            kind: 'credits-bundle',
            productId: 'legacy_unknown_sku',
            label: 'Legacy bundle',
            amount: 100_000,
            createdAt: new Date('2020-01-15T00:00:00.000Z'),
          },
        ],
      });

      await prisma.webhookEventLog.createMany({
        data: [
          {
            id: uuidv7(),
            source: 'iap',
            eventType: 'DID_RENEW',
            reference: 'txn-1',
            outcome: 'ok',
            detail: { businessId: BUSINESS_A },
          },
          {
            id: uuidv7(),
            source: 'iap',
            eventType: 'DID_FAIL_TO_RENEW',
            reference: 'txn-2',
            outcome: 'error',
            // No detail payload at all: the view must report businessName null, not a guess.
          },
          {
            id: uuidv7(),
            source: 'paystack',
            eventType: 'charge.success',
            reference: 'ps-1',
            outcome: 'ok',
            detail: { businessId: BUSINESS_B },
          },
        ],
      });
    });

    describe('GET /admin/billing/subscriptions', () => {
      it('returns Paged<AdminSubscriptionView> with plan price joined and honest null source', async () => {
        const res = await get('/admin/billing/subscriptions');
        expect(res.status).toBe(200);
        expect(res.body.page).toBe(1);
        expect(res.body.total).toBe(3);
        expect(res.body.data).toHaveLength(3);

        for (const row of res.body.data) {
          expect(typeof row.businessId).toBe('string');
          expect(typeof row.businessName).toBe('string');
          expect(typeof row.plan).toBe('string');
          expect(typeof row.priceKobo).toBe('number');
          expect(row.source).toBeNull();
          expect(row.currentPeriodEnd === null || typeof row.currentPeriodEnd === 'string').toBe(
            true,
          );
          expect(['none', 'pending', 'active', 'gracePeriod', 'expired']).toContain(row.state);
        }

        const a = res.body.data.find(
          (r: Record<string, unknown>) => r.businessId === BUSINESS_A,
        );
        expect(a.businessName).toBe('Mama Nkechi Provisions');
        expect(a.plan).toBe('market');
        expect(a.priceKobo).toBe(250_000);
        expect(a.currentPeriodEnd).toBe(RENEWAL.toISOString());
        expect(a.state).toBe('active');

        // Expired row reports the ENTITLED plan (starter, free), not the requested one.
        const c = res.body.data.find(
          (r: Record<string, unknown>) => r.businessId === BUSINESS_C,
        );
        expect(c.plan).toBe('starter');
        expect(c.priceKobo).toBe(0);
        expect(c.currentPeriodEnd).toBeNull();
      });

      it('filters by state', async () => {
        const active = await get('/admin/billing/subscriptions', { state: 'active' });
        expect(active.status).toBe(200);
        expect(active.body.total).toBe(1);
        expect(active.body.data[0].businessId).toBe(BUSINESS_A);

        const none = await get('/admin/billing/subscriptions', { state: 'none' });
        expect(none.body).toEqual({ data: [], page: 1, total: 0 });
      });

      it('paginates by offset with a stable order', async () => {
        const page1 = await get('/admin/billing/subscriptions', { page: 1, limit: 2 });
        expect(page1.body.data).toHaveLength(2);
        expect(page1.body.total).toBe(3);
        const page2 = await get('/admin/billing/subscriptions', { page: 2, limit: 2 });
        expect(page2.body.data).toHaveLength(1);
        expect(page2.body.page).toBe(2);
        const ids = page1.body.data.map((r: Record<string, unknown>) => r.businessId);
        expect(ids).not.toContain(page2.body.data[0].businessId);
      });

      it('rejects an unknown state and out-of-range paging -> 422 VALIDATION_ERROR', async () => {
        const badQueries: Record<string, string | number>[] = [
          { state: 'cancelled' },
          { limit: 0 },
          { limit: 101 },
          { page: 0 },
        ];
        for (const query of badQueries) {
          const res = await get('/admin/billing/subscriptions', query);
          expect(res.status).toBe(422);
          expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
      });
    });

    describe('GET /admin/billing/transactions', () => {
      it('defaults to the current month and joins the catalog price beside gross', async () => {
        const res = await get('/admin/billing/transactions');
        expect(res.status).toBe(200);
        expect(res.body.page).toBe(1);
        // The 2020 row is outside the default (current) month.
        expect(res.body.total).toBe(2);

        for (const row of res.body.data) {
          expect(typeof row.id).toBe('string');
          expect(new Date(row.at as string).toISOString()).toBe(row.at);
          expect(typeof row.businessName).toBe('string');
          expect(['subscription', 'credits-bundle']).toContain(row.kind);
          expect(typeof row.sku).toBe('string');
          expect(typeof row.grossKobo).toBe('number');
          expect(row.storeFeeKobo).toBeNull();
          expect(row.netKobo).toBeNull();
        }

        const plan = res.body.data.find((r: Record<string, unknown>) => r.id === txnIds[0]);
        expect(plan.businessName).toBe('Mama Nkechi Provisions');
        expect(plan.kind).toBe('subscription');
        expect(plan.sku).toBe('oweme_market_monthly');
        expect(plan.grossKobo).toBe(250_000);
        expect(plan.catalogPriceKobo).toBe(250_000);

        // Webhook-recorded bundle: gross 0, list price still shown from bundle-catalog.
        const bundle = res.body.data.find((r: Record<string, unknown>) => r.id === txnIds[1]);
        expect(bundle.grossKobo).toBe(0);
        expect(bundle.catalogPriceKobo).toBe(400_000);
      });

      it('honours the month filter and leaves unknown SKUs with a null catalog price', async () => {
        const res = await get('/admin/billing/transactions', { month: '2020-01' });
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(1);
        expect(res.body.data[0].sku).toBe('legacy_unknown_sku');
        expect(res.body.data[0].catalogPriceKobo).toBeNull();
        expect(res.body.data[0].grossKobo).toBe(100_000);

        const empty = await get('/admin/billing/transactions', { month: '2019-05' });
        expect(empty.body).toEqual({ data: [], page: 1, total: 0 });
      });

      it('searches business name, SKU and kind', async () => {
        const byBusiness = await get('/admin/billing/transactions', { search: 'Okoro' });
        expect(byBusiness.body.total).toBe(1);
        expect(byBusiness.body.data[0].id).toBe(txnIds[1]);

        const bySku = await get('/admin/billing/transactions', { search: 'market_monthly' });
        expect(bySku.body.total).toBe(1);
        expect(bySku.body.data[0].id).toBe(txnIds[0]);

        const byKind = await get('/admin/billing/transactions', { search: 'credits-bundle' });
        expect(byKind.body.total).toBe(1);
        expect(byKind.body.data[0].id).toBe(txnIds[1]);

        const miss = await get('/admin/billing/transactions', { search: 'No Such Shop' });
        expect(miss.body).toEqual({ data: [], page: 1, total: 0 });
      });

      it('paginates by offset', async () => {
        const page1 = await get('/admin/billing/transactions', {
          month: currentMonth(),
          page: 1,
          limit: 1,
        });
        expect(page1.body.data).toHaveLength(1);
        expect(page1.body.total).toBe(2);
        const page2 = await get('/admin/billing/transactions', {
          month: currentMonth(),
          page: 2,
          limit: 1,
        });
        expect(page2.body.data).toHaveLength(1);
        expect(page2.body.page).toBe(2);
        expect(page1.body.data[0].id).not.toBe(page2.body.data[0].id);
      });

      it('rejects a malformed month -> 422 VALIDATION_ERROR', async () => {
        const res = await get('/admin/billing/transactions', { month: '2026-13' });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      });
    });

    describe('GET /admin/billing/stats', () => {
      it('counts entitlements and sums flat-plan MRR, fee/renewal fields honest null', async () => {
        const res = await get('/admin/billing/stats');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          activeSubscriptionCount: 1,
          graceSubscriptionCount: 1,
          // Only the ACTIVE market subscription contributes; grace and expired do not.
          mrrKobo: 250_000,
          storeFeeMonthKobo: null,
          failedRenewalsThisMonth: null,
        });
      });
    });

    describe('GET /admin/billing/iap-lifecycle', () => {
      it('sweeps entitlement states now and lists only source=iap events', async () => {
        const res = await get('/admin/billing/iap-lifecycle');
        expect(res.status).toBe(200);
        expect(res.body.entitlementStateCounts).toEqual({
          none: 0,
          pending: 0,
          active: 1,
          gracePeriod: 1,
          expired: 1,
        });

        expect(res.body.events.page).toBe(1);
        // The paystack row is not part of the IAP feed.
        expect(res.body.events.total).toBe(2);
        const types = res.body.events.data.map((e: Record<string, unknown>) => e.eventType);
        expect(types.sort()).toEqual(['DID_FAIL_TO_RENEW', 'DID_RENEW']);

        for (const event of res.body.events.data) {
          expect(typeof event.id).toBe('string');
          expect(new Date(event.at as string).toISOString()).toBe(event.at);
          expect(['ok', 'ignored', 'error']).toContain(event.outcome);
          expect(event.businessName === null || typeof event.businessName === 'string').toBe(true);
          expect(event.detail === null || typeof event.detail === 'object').toBe(true);
        }

        const renew = res.body.events.data.find(
          (e: Record<string, unknown>) => e.eventType === 'DID_RENEW',
        );
        expect(renew.businessName).toBe('Mama Nkechi Provisions');
        expect(renew.outcome).toBe('ok');

        // No businessId in the detail -> honest null, never a guess.
        const failed = res.body.events.data.find(
          (e: Record<string, unknown>) => e.eventType === 'DID_FAIL_TO_RENEW',
        );
        expect(failed.businessName).toBeNull();
        expect(failed.detail).toBeNull();
      });

      it('paginates the events feed while the census stays whole', async () => {
        const page1 = await get('/admin/billing/iap-lifecycle', { page: 1, limit: 1 });
        expect(page1.body.events.data).toHaveLength(1);
        expect(page1.body.events.total).toBe(2);
        expect(page1.body.entitlementStateCounts.active).toBe(1);

        const page2 = await get('/admin/billing/iap-lifecycle', { page: 2, limit: 1 });
        expect(page2.body.events.data).toHaveLength(1);
        expect(page2.body.events.page).toBe(2);
        expect(page1.body.events.data[0].id).not.toBe(page2.body.events.data[0].id);
      });

      it('rejects out-of-range paging -> 422 VALIDATION_ERROR', async () => {
        const res = await get('/admin/billing/iap-lifecycle', { limit: 101 });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      });
    });
  });

  describe('read-only invariant', () => {
    it('exposes no write route -> 404 NOT_FOUND', async () => {
      const attempts: ['post' | 'put' | 'patch' | 'delete', string][] = [
        ['post', '/admin/billing/subscriptions'],
        ['patch', `/admin/billing/subscriptions/${BUSINESS_A}`],
        ['delete', `/admin/billing/subscriptions/${BUSINESS_A}`],
        ['post', '/admin/billing/transactions'],
        ['put', '/admin/billing/stats'],
      ];
      for (const [method, path] of attempts) {
        const res = await request(app.getHttpServer())
          [method](path)
          .set('Authorization', `Bearer ${rootAccess}`);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
    });

    it('records no audit rows (all four routes are reads)', async () => {
      await prisma.adminAuditLog.deleteMany({});
      for (const path of ROUTES) expect((await get(path)).status).toBe(200);
      expect(await prisma.adminAuditLog.count()).toBe(0);
    });
  });
});
