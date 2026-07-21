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
import { AdminOverviewModule } from '../admin-overview.module';

// Admin secrets are env-driven with no insecure fallback; specs boot with explicit
// test values, mirroring how test/setenv.ts boots the user-auth specs.
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET ?? 'test-admin-access-secret';
process.env.ADMIN_JWT_REFRESH_SECRET =
  process.env.ADMIN_JWT_REFRESH_SECRET ?? 'test-admin-refresh-secret';

/** Spy OtpSender so the spec can mint a REAL user session for the cross-rejection gate. */
class SpyOtpSender implements OtpSender {
  readonly codes = new Map<string, string>();
  async sendOtp(phone: string, code: string): Promise<void> {
    this.codes.set(phone, code);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Independent restatement of the service's ISO-week boundary (Monday 00:00 UTC). */
const weekStart = (at: Date): Date => {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY_MS);
};

const monthStartOf = (at: Date): Date =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));

/**
 * AdminOverview (contract). Same boot as app.module (global user guards,
 * ValidationPipe, HttpExceptionFilter) plus the AdminModule aggregate (for admin
 * login), the user AuthModule (for a real user token) and this resource's module,
 * which the integrator later folds into AdminModule. Covers the empty-platform read,
 * every aggregate against seeded rows (headcounts, flat-plan MRR, band total, credit
 * burn, pay-link money + commission, the 12-week series, plan ladder counts), the
 * union activity feed with its limit filter, and both auth/role gates.
 */
describe('AdminOverview (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sender = new SpyOtpSender();

  const ROOT_EMAIL = 'root-overview@oweme.app';
  const ROOT_PASSWORD = 'RootPass!2026';
  const SUPPORT_EMAIL = 'support-overview@oweme.app';
  const SUPPORT_PASSWORD = 'SupportPass!1';
  const USER_PHONE = '2348039990088';
  let rootAccess: string;
  let supportAccess: string;

  const NOW = new Date();
  const MONTH_START = monthStartOf(NOW);
  const WEEKS_START = weekStart(new Date(NOW.getTime() - 11 * WEEK_MS));
  // Two days before this month began: outside the current month, inside the 12-week window.
  const LAST_MONTH = new Date(MONTH_START.getTime() - 2 * DAY_MS);
  // Well outside the sparkline window.
  const LONG_AGO = new Date(NOW.getTime() - 30 * WEEK_MS);
  // Recent activity anchor, clamped inside the current month so the money assertions
  // hold even when the suite runs in the first hours of a new month.
  const ANCHOR = new Date(
    Math.max(MONTH_START.getTime() + 60_000, NOW.getTime() - 3 * 60 * 60 * 1000),
  );
  const SUB_AT = ANCHOR;
  const BUNDLE_AT = new Date(ANCHOR.getTime() + 60_000);
  const PAY_A_AT = new Date(ANCHOR.getTime() + 120_000);
  const PAY_B_AT = new Date(ANCHOR.getTime() + 180_000);

  const BIZ = {
    starterA: uuidv7(),
    market: uuidv7(),
    business: uuidv7(),
    wholesale: uuidv7(),
    enterprise: uuidv7(),
    starterB: uuidv7(),
  };
  const SUB_PAYMENT_ID = uuidv7();
  const BUNDLE_PAYMENT_ID = uuidv7();
  const PAY_LINK_A = uuidv7();
  const PAY_LINK_B = uuidv7();
  const PAY_LINK_LAST_MONTH = uuidv7();
  const PAY_LINK_LONG_AGO = uuidv7();

  const login = async (email: string, password: string) =>
    request(app.getHttpServer()).post('/admin/auth/login').send({ email, password });

  const summary = async (token: string = rootAccess) =>
    request(app.getHttpServer()).get('/admin/overview').set('Authorization', `Bearer ${token}`);

  const activity = async (
    query: Record<string, string | number> = {},
    token: string = rootAccess,
  ) =>
    request(app.getHttpServer())
      .get('/admin/overview/activity')
      .query(query)
      .set('Authorization', `Bearer ${token}`);

  const expectSummaryShape = (body: Record<string, unknown>): void => {
    expect(Object.keys(body).sort()).toEqual([
      'activePaidSubscriptions',
      'commissionThisMonthKobo',
      'creditsBurnedThisMonth',
      'enterpriseBandsTotal',
      'mrrKobo',
      'planCounts',
      'recoveredThisMonthKobo',
      'registeredBusinesses',
      'weeklyRecoveredKobo',
    ]);
    for (const key of [
      'registeredBusinesses',
      'activePaidSubscriptions',
      'mrrKobo',
      'enterpriseBandsTotal',
      'creditsBurnedThisMonth',
      'recoveredThisMonthKobo',
      'commissionThisMonthKobo',
    ]) {
      expect(Number.isInteger(body[key])).toBe(true);
    }
    expect(Array.isArray(body.weeklyRecoveredKobo)).toBe(true);
    expect(body.weeklyRecoveredKobo as number[]).toHaveLength(12);
    expect(Object.keys(body.planCounts as object).sort()).toEqual([
      'business',
      'enterprise',
      'market',
      'starter',
      'wholesale',
    ]);
  };

  const expectEventShape = (e: Record<string, unknown>): void => {
    expect(Object.keys(e).sort()).toEqual(['at', 'business', 'event', 'id', 'tone']);
    expect(typeof e.id).toBe('string');
    expect(typeof e.business).toBe('string');
    expect(typeof e.event).toBe('string');
    expect(['brand', 'gold', 'neutral', 'danger', 'info']).toContain(e.tone);
    expect(new Date(e.at as string).toISOString()).toBe(e.at);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, AdminModule, AdminOverviewModule, AuthModule],
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
      [ROOT_EMAIL, 'Overview Root', 'superadmin', ROOT_PASSWORD],
      [SUPPORT_EMAIL, 'Overview Support', 'support', SUPPORT_PASSWORD],
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
  });

  afterAll(async () => {
    await app.close();
  });

  // Runs first, against the untouched fresh DB: only the seeded Plan catalog exists.
  describe('empty platform', () => {
    it('GET /admin/overview returns honest zeros, not an error', async () => {
      const res = await summary();
      expect(res.status).toBe(200);
      expectSummaryShape(res.body);
      expect(res.body).toEqual({
        registeredBusinesses: 0,
        activePaidSubscriptions: 0,
        mrrKobo: 0,
        enterpriseBandsTotal: 0,
        creditsBurnedThisMonth: 0,
        recoveredThisMonthKobo: 0,
        commissionThisMonthKobo: 0,
        weeklyRecoveredKobo: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        planCounts: { starter: 0, market: 0, business: 0, wholesale: 0, enterprise: 0 },
      });
    });

    it('GET /admin/overview/activity returns an empty feed', async () => {
      const res = await activity();
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('seeded platform', () => {
    beforeAll(async () => {
      const business = async (id: string, name: string, plan: string, extra: object = {}) =>
        prisma.business.create({
          data: {
            id,
            businessName: name,
            ownerName: 'Owner',
            phone: '2348000000000',
            category: 'Retail',
            currency: 'NGN (₦)',
            reminderTone: 'friendly',
            plan,
            ...extra,
          },
        });

      await business(BIZ.starterA, 'Mama Nkechi Provisions', 'starter', {
        createdAt: new Date(NOW.getTime() - 10 * DAY_MS),
      });
      await business(BIZ.market, 'Okoro Electronics', 'market', {
        createdAt: new Date(NOW.getTime() - 9 * DAY_MS),
      });
      await business(BIZ.business, 'Golden Gate Pharmacy', 'business', {
        createdAt: new Date(NOW.getTime() - 8 * DAY_MS),
      });
      await business(BIZ.wholesale, 'PH Wholesale Foods', 'wholesale', {
        createdAt: new Date(NOW.getTime() - 7 * DAY_MS),
      });
      await business(BIZ.enterprise, 'Trans-Amadi Cement Depot', 'enterprise', {
        enterpriseBands: 3,
        createdAt: new Date(NOW.getTime() - 6 * DAY_MS),
      });
      await business(BIZ.starterB, 'Blessing Fabrics', 'starter', {
        createdAt: new Date(NOW.getTime() - 5 * DAY_MS),
      });

      // Paid + active: market, business, enterprise. The expired wholesale row and the
      // active-but-free starter row must both stay out of the paid count and out of MRR.
      for (const [businessId, planId, state] of [
        [BIZ.market, 'market', 'active'],
        [BIZ.business, 'business', 'active'],
        [BIZ.enterprise, 'enterprise', 'active'],
        [BIZ.wholesale, 'wholesale', 'expired'],
        [BIZ.starterB, 'starter', 'active'],
      ]) {
        await prisma.subscription.create({
          data: { businessId, planId, entitlementState: state, activePlanId: planId },
        });
      }

      // Credit ledgers: 180 burned this period (300-120) + 0 (bundle balance above grant).
      // The fair-use ledger and the stale-period ledger are both excluded.
      for (const [businessId, monthlyGrant, balance, periodStart] of [
        [BIZ.market, 300, 120, MONTH_START],
        [BIZ.business, 1_200, 1_500, MONTH_START],
        [BIZ.enterprise, -1, -1, MONTH_START],
        [BIZ.starterA, 50, 10, new Date(MONTH_START.getTime() - 5 * DAY_MS)],
      ] as [string, number, number, Date][]) {
        await prisma.creditLedger.create({
          data: { businessId, monthlyGrant, balance, periodStart },
        });
      }

      const customerId = uuidv7();
      const debtId = uuidv7();
      await prisma.customer.create({
        data: { id: customerId, businessId: BIZ.market, name: 'Chidi', phone: '08030000000' },
      });
      await prisma.debt.create({
        data: { id: debtId, businessId: BIZ.market, customerId, amount: 50_000_000 },
      });

      for (const [id, amount, method, createdAt] of [
        [PAY_LINK_A, 500_000, 'Paystack link', PAY_A_AT],
        [PAY_LINK_B, 20_000_000, 'Paystack link', PAY_B_AT],
        [PAY_LINK_LAST_MONTH, 700_000, 'Paystack link', LAST_MONTH],
        [PAY_LINK_LONG_AGO, 100_000, 'Paystack link', LONG_AGO],
        // Cash never counts as pay-link recovery.
        [uuidv7(), 900_000, 'Cash', PAY_A_AT],
      ] as [string, number, string, Date][]) {
        await prisma.payment.create({
          data: {
            id,
            businessId: BIZ.market,
            debtId,
            amount,
            method,
            reference: `OWM-${id.slice(0, 6)}`,
            createdAt,
          },
        });
      }

      for (const [id, kind, label, amount, createdAt] of [
        [SUB_PAYMENT_ID, 'subscription', 'Market monthly', 250_000, SUB_AT],
        [BUNDLE_PAYMENT_ID, 'credits-bundle', '250 credits', 150_000, BUNDLE_AT],
      ] as [string, string, string, number, Date][]) {
        await prisma.billingTransaction.create({
          data: { id, businessId: BIZ.market, kind, productId: 'prod', label, amount, createdAt },
        });
      }
    });

    it('counts businesses and active PAID subscriptions (starter and expired excluded)', async () => {
      const res = await summary();
      expect(res.status).toBe(200);
      expectSummaryShape(res.body);
      expect(res.body.registeredBusinesses).toBe(6);
      expect(res.body.activePaidSubscriptions).toBe(3);
    });

    it('MRR is the flat plan component only, with the band total returned separately', async () => {
      const res = await summary();
      // market 250,000 + business 600,000 + enterprise 2,500,000 kobo.
      expect(res.body.mrrKobo).toBe(3_350_000);
      expect(res.body.enterpriseBandsTotal).toBe(3);
    });

    it('credits burned covers current-period metered ledgers only', async () => {
      const res = await summary();
      expect(res.body.creditsBurnedThisMonth).toBe(180);
    });

    it('does not refill ledgers as a side effect of the aggregate read', async () => {
      await summary();
      const stale = await prisma.creditLedger.findUnique({ where: { businessId: BIZ.starterA } });
      expect(stale!.balance).toBe(10);
      expect(stale!.periodStart.getTime()).toBe(MONTH_START.getTime() - 5 * DAY_MS);
    });

    it('pay-link money this month, with commission re-derived at 1% capped N500', async () => {
      const res = await summary();
      expect(res.body.recoveredThisMonthKobo).toBe(20_500_000);
      // 1% of 500,000 = 5,000; 1% of 20,000,000 = 200,000 capped to 50,000.
      expect(res.body.commissionThisMonthKobo).toBe(55_000);
    });

    it('returns 12 weekly recovery buckets, oldest first, window-clipped', async () => {
      const res = await summary();
      const weekly = res.body.weeklyRecoveredKobo as number[];
      expect(weekly).toHaveLength(12);

      const expected = new Array<number>(12).fill(0);
      for (const [amount, at] of [
        [500_000, PAY_A_AT],
        [20_000_000, PAY_B_AT],
        [700_000, LAST_MONTH],
      ] as [number, Date][]) {
        const bucket = Math.round(
          (weekStart(at).getTime() - WEEKS_START.getTime()) / WEEK_MS,
        );
        expected[bucket] += amount;
      }
      expect(weekly).toEqual(expected);
      // The 30-week-old payment is clipped out of the window entirely.
      expect(weekly.reduce((a, b) => a + b, 0)).toBe(21_200_000);
    });

    it('counts businesses across the full five-tier ladder, including starter', async () => {
      const res = await summary();
      expect(res.body.planCounts).toEqual({
        starter: 2,
        market: 1,
        business: 1,
        wholesale: 1,
        enterprise: 1,
      });
    });

    it('activity unions registrations, billing and pay links, newest first', async () => {
      const res = await activity();
      expect(res.status).toBe(200);
      for (const event of res.body) expectEventShape(event);
      expect(res.body).toHaveLength(10);

      const top = res.body.slice(0, 4) as Record<string, unknown>[];
      expect(top.map((e) => [e.event, e.tone, e.business])).toEqual([
        ['Pay link recovery', 'info', 'Okoro Electronics'],
        ['Pay link recovery', 'info', 'Okoro Electronics'],
        ['Credit bundle purchased', 'gold', 'Okoro Electronics'],
        ['Subscription payment', 'brand', 'Okoro Electronics'],
      ]);
      expect(top.map((e) => e.id)).toEqual([
        `payment-${PAY_LINK_B}`,
        `payment-${PAY_LINK_A}`,
        `billing-${BUNDLE_PAYMENT_ID}`,
        `billing-${SUB_PAYMENT_ID}`,
      ]);

      const timestamps = (res.body as Record<string, unknown>[]).map((e) =>
        new Date(e.at as string).getTime(),
      );
      expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
    });

    it('activity honours the limit filter', async () => {
      const res = await activity({ limit: 3 });
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(3);
      expect((res.body as Record<string, unknown>[]).map((e) => e.id)).toEqual([
        `payment-${PAY_LINK_B}`,
        `payment-${PAY_LINK_A}`,
        `billing-${BUNDLE_PAYMENT_ID}`,
      ]);

      const max = await activity({ limit: 50 });
      expect(max.status).toBe(200);
      // Every seeded source row: 6 registrations + 2 billing + 4 pay links.
      expect(max.body).toHaveLength(12);

      const registrations = (max.body as Record<string, unknown>[]).filter(
        (e) => e.event === 'Business registered',
      );
      expect(registrations).toHaveLength(6);
      expect(registrations.every((e) => e.tone === 'neutral')).toBe(true);
      expect(registrations[0].business).toBe('Blessing Fabrics');
      expect(registrations[0].id).toBe(`business-${BIZ.starterB}`);
    });

    it('rejects out-of-range limits', async () => {
      for (const limit of [0, 51, 'ten']) {
        const res = await activity({ limit });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('is a read-only surface: no write route and no audit rows', async () => {
      for (const [method, path] of [
        ['post', '/admin/overview'],
        ['patch', '/admin/overview'],
        ['delete', '/admin/overview/activity'],
      ] as ['post' | 'patch' | 'delete', string][]) {
        const res = await request(app.getHttpServer())
          [method](path)
          .set('Authorization', `Bearer ${rootAccess}`);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
      // The only rows in the log are the two setup logins written by AdminAuth.
      expect(await prisma.adminAuditLog.count({ where: { actionType: { not: 'login' } } })).toBe(0);
    });
  });

  describe('auth and role gates', () => {
    it('no token -> 401 UNAUTHENTICATED on both endpoints', async () => {
      for (const path of ['/admin/overview', '/admin/overview/activity']) {
        const res = await request(app.getHttpServer()).get(path);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('garbage token -> 401', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/overview')
        .set('Authorization', 'Bearer not-a-token');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('a valid USER access token is rejected on the admin routes -> 401', async () => {
      const otpReq = await request(app.getHttpServer())
        .post('/auth/request-otp')
        .send({ phone: USER_PHONE });
      expect(otpReq.status).toBe(202);
      const code = sender.codes.get(USER_PHONE)!;
      const userSession = await request(app.getHttpServer())
        .post('/auth/verify-otp')
        .send({ phone: USER_PHONE, code });
      expect(userSession.status).toBe(200);

      for (const path of ['/admin/overview', '/admin/overview/activity']) {
        const res = await request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${userSession.body.accessToken}`);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('both registry roles may read: superadmin and support -> 200', async () => {
      const rootSummary = await summary(rootAccess);
      const supportSummary = await summary(supportAccess);
      expect(supportSummary.status).toBe(200);
      expect(supportSummary.body).toEqual(rootSummary.body);

      const supportActivity = await activity({}, supportAccess);
      expect(supportActivity.status).toBe(200);
      expect(supportActivity.body).toEqual((await activity({}, rootAccess)).body);
    });
  });
});
