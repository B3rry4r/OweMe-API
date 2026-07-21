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
import { AdminCommonModule, hashPassword } from '../../common';
import { AdminAuthModule } from '../../auth/admin-auth.module';
import { AdminCreditsModule } from '../admin-credits.module';
import { currentPeriodStart } from '../../../usage/period.util';

// Admin secrets are env-driven with no insecure fallback; specs boot with explicit
// test values, mirroring how test/setenv.ts boots the user-auth specs.
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET ?? 'test-admin-access-secret';
process.env.ADMIN_JWT_REFRESH_SECRET =
  process.env.ADMIN_JWT_REFRESH_SECRET ?? 'test-admin-refresh-secret';

/** Spy OtpSender so the spec can mint a REAL user session for cross-rejection. */
class SpyOtpSender implements OtpSender {
  readonly codes = new Map<string, string>();
  async sendOtp(phone: string, code: string): Promise<void> {
    this.codes.set(phone, code);
  }
}

/**
 * AdminCreditsView (contract). Boots the resource in isolation with the same global
 * guards, ValidationPipe and HttpExceptionFilter as app.module, plus AdminAuthModule
 * for real admin sessions and the user AuthModule for a real user token.
 *
 * Covers: the empty-table reads (usage_events is not instrumented yet, so honest zeros
 * and empty arrays are the shipped state), the seeded derivations, plan filtering,
 * offset pagination, month scoping, the constants feed, and the auth/role gates.
 */
describe('AdminCreditsView (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sender = new SpyOtpSender();

  const ROOT_EMAIL = 'root-credits@oweme.app';
  const ROOT_PASSWORD = 'RootPass!2026';
  const SUPPORT_EMAIL = 'support-credits@oweme.app';
  const SUPPORT_PASSWORD = 'SupportPass!1';
  const USER_PHONE = '2348039990077';
  let rootAccess: string;
  let supportAccess: string;

  const BUSINESS_A = uuidv7(); // Mama Nkechi Provisions, market, 2 bundles
  const BUSINESS_B = uuidv7(); // Okoro Electronics, starter
  const BUSINESS_C = uuidv7(); // Delta Wholesale Ltd, enterprise (fair use)
  const BUSINESS_D = uuidv7(); // Stale Ledger Stores, ledger left in last period
  const ALL_BUSINESSES = [BUSINESS_A, BUSINESS_B, BUSINESS_C, BUSINESS_D];

  const period = currentPeriodStart();
  const monthLabel = `${period.getUTCFullYear()}-${String(
    period.getUTCMonth() + 1,
  ).padStart(2, '0')}`;
  /** Any instant inside the previous calendar month. */
  const lastMonth = new Date(period.getTime() - 24 * 60 * 60 * 1000);
  const lastMonthLabel = `${lastMonth.getUTCFullYear()}-${String(
    lastMonth.getUTCMonth() + 1,
  ).padStart(2, '0')}`;
  /** A safely-inside-the-month instant for seeded current-period rows. */
  const inMonth = (offsetMinutes: number) =>
    new Date(period.getTime() + 60 * 1000 * (offsetMinutes + 1));

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

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CommonModule,
        AdminCommonModule,
        AdminAuthModule,
        AdminCreditsModule,
        AuthModule,
      ],
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
      [ROOT_EMAIL, 'Credits Root', 'superadmin', ROOT_PASSWORD],
      [SUPPORT_EMAIL, 'Credits Support', 'support', SUPPORT_PASSWORD],
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

    // Start from a genuinely empty credits surface so the empty-table block is honest.
    await prisma.usageEvent.deleteMany({});
    await prisma.creditLedger.deleteMany({});
    await prisma.billingTransaction.deleteMany({});

    for (const [id, businessName, plan] of [
      [BUSINESS_A, 'Mama Nkechi Provisions', 'market'],
      [BUSINESS_B, 'Okoro Electronics', 'starter'],
      [BUSINESS_C, 'Delta Wholesale Ltd', 'enterprise'],
      [BUSINESS_D, 'Stale Ledger Stores', 'starter'],
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
          plan,
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.usageEvent.deleteMany({});
    await prisma.creditLedger.deleteMany({});
    await prisma.billingTransaction.deleteMany({});
    await prisma.business.deleteMany({ where: { id: { in: ALL_BUSINESSES } } });
    await app.close();
  });

  describe('empty tables (usage_events not instrumented yet)', () => {
    it('GET /admin/credits/stats -> honest zeros and an empty burn breakdown', async () => {
      const res = await get('/admin/credits/stats');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        grantedThisMonth: 0,
        burnedThisMonth: 0,
        monthLabel,
        burnByType: [],
      });
    });

    it('GET /admin/credits/heavy-users -> empty page envelope', async () => {
      const res = await get('/admin/credits/heavy-users');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [], page: 1, total: 0 });
    });

    it('GET /admin/credits/bundle-purchases -> empty page envelope', async () => {
      const res = await get('/admin/credits/bundle-purchases');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [], page: 1, total: 0 });
    });
  });

  describe('GET /admin/credits/config (constants feed)', () => {
    it('serves the cap, CREDIT_WEIGHTS, the SKU catalog and the seeded plan grants', async () => {
      const res = await get('/admin/credits/config');
      expect(res.status).toBe(200);
      expect(res.body.bundleCapPerMonth).toBe(2);
      expect(res.body.creditWeights).toEqual({ send: 5, voiceParse: 1, insightOrRisk: 4 });
      expect(res.body.bundles).toEqual([
        { sku: 'oweme_credits_250', credits: 250, priceKobo: 200_000 },
        { sku: 'oweme_credits_600', credits: 600, priceKobo: 400_000 },
        { sku: 'oweme_credits_1500', credits: 1_500, priceKobo: 800_000 },
      ]);
      expect(res.body.planGrants.map((g: Record<string, unknown>) => g.planId)).toEqual([
        'starter',
        'market',
        'business',
        'wholesale',
        'enterprise',
      ]);
      expect(res.body.planGrants[0]).toEqual({ planId: 'starter', creditsPerMonth: 50 });
      // Fair use is reported as null, never as the raw -1 sentinel.
      expect(res.body.planGrants[4]).toEqual({ planId: 'enterprise', creditsPerMonth: null });
      expect(typeof res.body.fairUseNote).toBe('string');
      expect(res.body.fairUseNote.length).toBeGreaterThan(0);
    });
  });

  describe('seeded month', () => {
    beforeAll(async () => {
      for (const [businessId, balance, monthlyGrant, periodStart] of [
        [BUSINESS_A, 100, 300, period],
        [BUSINESS_B, 20, 50, period],
        [BUSINESS_C, -1, -1, period],
        [BUSINESS_D, 5, 50, lastMonth], // stale: untouched this month
      ] as [string, number, number, Date][]) {
        await prisma.creditLedger.create({
          data: { businessId, balance, monthlyGrant, periodStart },
        });
      }

      for (const [businessId, productId, amount, createdAt] of [
        [BUSINESS_A, 'oweme_credits_250', 0, inMonth(10)], // webhook row: amount 0
        [BUSINESS_A, 'oweme_credits_600', 400_000, inMonth(20)],
        [BUSINESS_B, 'oweme_credits_9999', 0, lastMonth], // last month, off-catalog SKU
      ] as [string, string, number, Date][]) {
        await prisma.billingTransaction.create({
          data: {
            id: uuidv7(),
            businessId,
            kind: 'credits-bundle',
            productId,
            label: productId,
            amount,
            createdAt,
          },
        });
      }

      // Subscription rows must never leak into the bundle history.
      await prisma.billingTransaction.create({
        data: {
          id: uuidv7(),
          businessId: BUSINESS_A,
          kind: 'subscription',
          productId: 'oweme_market_monthly',
          label: 'Market monthly',
          amount: 500_000,
          createdAt: inMonth(30),
        },
      });

      for (const [businessId, type, credits] of [
        [BUSINESS_C, 'send', 5],
        [BUSINESS_C, 'send', 5],
        [BUSINESS_C, 'voiceParse', 1],
        [BUSINESS_A, 'insight', 4],
      ] as [string, string, number][]) {
        await prisma.usageEvent.create({
          data: { id: uuidv7(), businessId, type, credits, createdAt: inMonth(5) },
        });
      }
    });

    it('GET /admin/credits/stats derives grants, burn and the per-type breakdown', async () => {
      const res = await get('/admin/credits/stats');
      expect(res.status).toBe(200);
      expect(res.body.monthLabel).toBe(monthLabel);
      // 300 (market) + 50 (starter); fair use excluded, stale ledger out of period.
      expect(res.body.grantedThisMonth).toBe(350);
      // A: 300 + 850 bundle credits - 100 = 1050; B: 50 - 20 = 30; C (fair use): 11 events.
      expect(res.body.burnedThisMonth).toBe(1_091);
      expect(res.body.burnByType).toEqual([
        { type: 'send', label: 'Reminder sends', creditsPerEvent: 5, events: 2, credits: 10 },
        { type: 'voiceParse', label: 'Voice parses', creditsPerEvent: 1, events: 1, credits: 1 },
        { type: 'insight', label: 'AI insights', creditsPerEvent: 4, events: 1, credits: 4 },
      ]);
    });

    it('GET /admin/credits/heavy-users ranks by used desc and flags fair use', async () => {
      const res = await get('/admin/credits/heavy-users');
      expect(res.status).toBe(200);
      expect(res.body.page).toBe(1);
      // The stale-period ledger is not part of this month's derivation.
      expect(res.body.total).toBe(3);
      expect(res.body.data.map((r: Record<string, unknown>) => r.businessName)).toEqual([
        'Mama Nkechi Provisions',
        'Okoro Electronics',
        'Delta Wholesale Ltd',
      ]);
      expect(res.body.data[0]).toEqual({
        businessId: BUSINESS_A,
        businessName: 'Mama Nkechi Provisions',
        plan: 'market',
        grant: 300,
        fairUse: false,
        used: 1_050,
        bundlesThisMonth: 2,
      });
      expect(res.body.data[2]).toEqual({
        businessId: BUSINESS_C,
        businessName: 'Delta Wholesale Ltd',
        plan: 'enterprise',
        grant: null,
        fairUse: true,
        used: 11,
        bundlesThisMonth: 0,
      });
    });

    it('GET /admin/credits/heavy-users filters by plan', async () => {
      const market = await get('/admin/credits/heavy-users', { plan: 'market' });
      expect(market.status).toBe(200);
      expect(market.body.total).toBe(1);
      expect(market.body.data[0].businessId).toBe(BUSINESS_A);

      const none = await get('/admin/credits/heavy-users', { plan: 'wholesale' });
      expect(none.status).toBe(200);
      expect(none.body).toEqual({ data: [], page: 1, total: 0 });
    });

    it('GET /admin/credits/heavy-users paginates by offset over the ranked list', async () => {
      const page1 = await get('/admin/credits/heavy-users', { page: 1, limit: 2 });
      expect(page1.status).toBe(200);
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.total).toBe(3);

      const page2 = await get('/admin/credits/heavy-users', { page: 2, limit: 2 });
      expect(page2.status).toBe(200);
      expect(page2.body.page).toBe(2);
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.data[0].businessId).toBe(BUSINESS_C);
    });

    it('GET /admin/credits/bundle-purchases lists the month newest first with catalog prices', async () => {
      const res = await get('/admin/credits/bundle-purchases');
      expect(res.status).toBe(200);
      expect(res.body.page).toBe(1);
      // Subscription transactions and last month's top-up are excluded.
      expect(res.body.total).toBe(2);
      expect(res.body.data[0].sku).toBe('oweme_credits_600');
      expect(res.body.data[0].businessName).toBe('Mama Nkechi Provisions');
      expect(res.body.data[0].credits).toBe(600);
      expect(res.body.data[0].priceKobo).toBe(400_000);
      expect(new Date(res.body.data[0].purchasedAt).toISOString()).toBe(
        res.body.data[0].purchasedAt,
      );
      // The webhook-recorded row carries amount 0; the price comes from the catalog.
      expect(res.body.data[1]).toMatchObject({
        sku: 'oweme_credits_250',
        credits: 250,
        priceKobo: 200_000,
      });
      expect(typeof res.body.data[1].id).toBe('string');
    });

    it('GET /admin/credits/bundle-purchases scopes to ?month and parses off-catalog SKUs', async () => {
      const res = await get('/admin/credits/bundle-purchases', { month: lastMonthLabel });
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.data[0]).toMatchObject({
        businessName: 'Okoro Electronics',
        sku: 'oweme_credits_9999',
        credits: 9_999,
        priceKobo: null,
      });

      const quiet = await get('/admin/credits/bundle-purchases', { month: '2020-01' });
      expect(quiet.status).toBe(200);
      expect(quiet.body).toEqual({ data: [], page: 1, total: 0 });
    });

    it('GET /admin/credits/bundle-purchases paginates by offset', async () => {
      const page1 = await get('/admin/credits/bundle-purchases', { page: 1, limit: 1 });
      expect(page1.status).toBe(200);
      expect(page1.body.data).toHaveLength(1);
      expect(page1.body.total).toBe(2);

      const page2 = await get('/admin/credits/bundle-purchases', { page: 2, limit: 1 });
      expect(page2.status).toBe(200);
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);
    });

    it('rejects out-of-range paging, unknown plans and malformed months -> 422', async () => {
      const cases: [string, Record<string, string | number>][] = [
        ['/admin/credits/heavy-users', { page: 0 }],
        ['/admin/credits/heavy-users', { limit: 0 }],
        ['/admin/credits/heavy-users', { limit: 51 }],
        ['/admin/credits/heavy-users', { plan: 'gold' }],
        ['/admin/credits/bundle-purchases', { page: 0 }],
        ['/admin/credits/bundle-purchases', { limit: 101 }],
        ['/admin/credits/bundle-purchases', { month: '2026-13' }],
        ['/admin/credits/bundle-purchases', { month: 'july' }],
      ];
      for (const [path, query] of cases) {
        const res = await get(path, query);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('auth and role gates (registry: superadmin + support)', () => {
    const paths = [
      '/admin/credits/stats',
      '/admin/credits/heavy-users',
      '/admin/credits/bundle-purchases',
      '/admin/credits/config',
    ];

    it('no token -> 401 UNAUTHENTICATED on every endpoint', async () => {
      for (const path of paths) {
        const res = await request(app.getHttpServer()).get(path);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('garbage token -> 401', async () => {
      for (const path of paths) {
        const res = await request(app.getHttpServer())
          .get(path)
          .set('Authorization', 'Bearer not-a-token');
        expect(res.status).toBe(401);
      }
    });

    it('a real USER access token is rejected -> 401', async () => {
      const otpReq = await request(app.getHttpServer())
        .post('/auth/request-otp')
        .send({ phone: USER_PHONE });
      expect(otpReq.status).toBe(202);
      const code = sender.codes.get(USER_PHONE)!;
      const session = await request(app.getHttpServer())
        .post('/auth/verify-otp')
        .send({ phone: USER_PHONE, code });
      expect(session.status).toBe(200);

      for (const path of paths) {
        const res = await get(path, {}, session.body.accessToken as string);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('support reads every endpoint (monitor surface, no write route exists)', async () => {
      for (const path of paths) {
        const res = await get(path, {}, supportAccess);
        expect(res.status).toBe(200);
      }

      const attempts: ['post' | 'patch' | 'delete', string][] = [
        ['post', '/admin/credits/stats'],
        ['patch', '/admin/credits/config'],
        ['delete', '/admin/credits/bundle-purchases'],
      ];
      for (const [method, path] of attempts) {
        const res = await request(app.getHttpServer())
          [method](path)
          .set('Authorization', `Bearer ${rootAccess}`);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
    });
  });
});
