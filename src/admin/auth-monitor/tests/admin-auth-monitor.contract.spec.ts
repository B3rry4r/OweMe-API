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
import { AdminAuthModule } from '../../auth/admin-auth.module';
import { hashPassword } from '../../common';
import { AdminAuthMonitorModule } from '../admin-auth-monitor.module';

// Admin secrets are env-driven with no insecure fallback; specs boot with explicit
// test values, mirroring how test/setenv.ts boots the user-auth specs.
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET ?? 'test-admin-access-secret';
process.env.ADMIN_JWT_REFRESH_SECRET =
  process.env.ADMIN_JWT_REFRESH_SECRET ?? 'test-admin-refresh-secret';

/**
 * AdminAuthMonitorView (contract). Same boot as app.module (global user guards,
 * ValidationPipe, HttpExceptionFilter) plus this resource's module and AdminAuthModule
 * for real logins; the user AuthModule rides along so a REAL user token proves
 * cross-rejection. Covers the empty-table reads (the state until the auth.service
 * instrumentation lands), the seeded shapes, filters + offset pagination, the
 * superadmin-only test-number gate and the structural isTest filter.
 */

/** Spy OtpSender so the spec can mint a REAL user session for cross-rejection. */
class SpyOtpSender implements OtpSender {
  readonly codes = new Map<string, string>();
  async sendOtp(phone: string, code: string): Promise<void> {
    this.codes.set(phone, code);
  }
}

describe('AdminAuthMonitorView (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sender = new SpyOtpSender();

  const ROOT_EMAIL = 'root-authmon@oweme.app';
  const ROOT_PASSWORD = 'RootPass!2026';
  const SUPPORT_EMAIL = 'support-authmon@oweme.app';
  const SUPPORT_PASSWORD = 'SupportPass!1';
  let rootAccess: string;
  let supportAccess: string;
  let userAccess: string;

  const USER_PHONE = '2348039990777';
  const TEST_BUSINESS = uuidv7();
  const TEST_BUSINESS_PHONE = '2348011110001';
  const REAL_BUSINESS = uuidv7();
  const REAL_BUSINESS_PHONE = '2348022220002';

  const PATHS = [
    '/admin/auth-monitor/stats',
    '/admin/auth-monitor/series',
    '/admin/auth-monitor/requests',
    '/admin/auth-monitor/test-numbers',
    '/admin/auth-monitor/sessions',
  ];

  const DAY_MS = 24 * 60 * 60 * 1000;
  const startOfUtcDay = (at: Date) =>
    new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

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

  const logRow = async (
    phoneMasked: string,
    outcome: string,
    createdAt: Date,
    attempts = 0,
    businessId: string | null = null,
  ) =>
    prisma.otpRequestLog.create({
      data: { id: uuidv7(), phoneMasked, outcome, attempts, businessId, createdAt },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, AdminAuthModule, AdminAuthMonitorModule, AuthModule],
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

    await prisma.otpRequestLog.deleteMany({});
    await prisma.otpCode.deleteMany({});
    await prisma.adminAuditLog.deleteMany({});
    await prisma.adminRefreshToken.deleteMany({});
    await prisma.adminUser.deleteMany({});
    for (const [email, name, role, password] of [
      [ROOT_EMAIL, 'Monitor Root', 'superadmin', ROOT_PASSWORD],
      [SUPPORT_EMAIL, 'Monitor Support', 'support', SUPPORT_PASSWORD],
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

    // A REAL user session (live OTP flow) for the cross-rejection assertions.
    await request(app.getHttpServer()).post('/auth/request-otp').send({ phone: USER_PHONE });
    const userSession = await request(app.getHttpServer())
      .post('/auth/verify-otp')
      .send({ phone: USER_PHONE, code: sender.codes.get(USER_PHONE)! });
    expect(userSession.status).toBe(200);
    userAccess = userSession.body.accessToken as string;

    // The user flow left an OtpCode-free but instrumented-free state; start clean.
    await prisma.otpRequestLog.deleteMany({});
    await prisma.otpCode.deleteMany({});
  });

  afterAll(async () => {
    await app.close();
  });

  describe('auth + role gates', () => {
    it('no token -> 401 UNAUTHENTICATED on every endpoint', async () => {
      for (const path of PATHS) {
        const res = await request(app.getHttpServer()).get(path);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('garbage token -> 401 on every endpoint', async () => {
      for (const path of PATHS) {
        const res = await request(app.getHttpServer())
          .get(path)
          .set('Authorization', 'Bearer not-a-token');
        expect(res.status).toBe(401);
      }
    });

    it('a valid USER token is rejected on every endpoint -> 401', async () => {
      // The same token works on the user surface.
      const userMe = await request(app.getHttpServer())
        .get('/me')
        .set('Authorization', `Bearer ${userAccess}`);
      expect(userMe.status).toBe(200);

      for (const path of PATHS) {
        const res = await get(path, {}, userAccess);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('support reads the monitor surfaces but NOT the test numbers -> 403 FORBIDDEN', async () => {
      for (const path of PATHS.filter((p) => !p.endsWith('test-numbers'))) {
        const res = await get(path, {}, supportAccess);
        expect(res.status).toBe(200);
      }

      const blocked = await get('/admin/auth-monitor/test-numbers', {}, supportAccess);
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('FORBIDDEN');

      const allowed = await get('/admin/auth-monitor/test-numbers');
      expect(allowed.status).toBe(200);
    });
  });

  describe('empty tables (state until instrumentation lands)', () => {
    it('stats reads honest zeros and a null delivery pct', async () => {
      const res = await get('/admin/auth-monitor/stats');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        otpRequestsToday: 0,
        deliverySuccessPct: null,
        failedVerificationsToday: 0,
        rateLimitBlocksToday: 0,
      });
    });

    it('series returns a zero-filled window of the requested length', async () => {
      const res = await get('/admin/auth-monitor/series', { days: 5 });
      expect(res.status).toBe(200);
      expect(res.body.counts).toEqual([0, 0, 0, 0, 0]);
      expect(res.body.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(res.body.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('requests returns an empty page', async () => {
      const res = await get('/admin/auth-monitor/requests');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [], page: 1, total: 0 });
    });

    it('test-numbers returns an empty array while no business is flagged', async () => {
      const res = await get('/admin/auth-monitor/test-numbers');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('sessions returns zeros, nulls and an empty revocation feed', async () => {
      await prisma.refreshToken.deleteMany({});
      const res = await get('/admin/auth-monitor/sessions');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        activeSessionCount: 0,
        revokedLast7d: 0,
        reuseIncidentsLast7d: null,
        logoutRevocationsLast7d: null,
        recentRevocations: { data: [], page: 1, total: 0 },
      });
    });
  });

  describe('GET /admin/auth-monitor/stats + /series (seeded)', () => {
    beforeAll(async () => {
      const now = new Date();
      // Same clock time on each earlier day, so every row lands in its own UTC bucket.
      const at = (dayOffset: number) => new Date(now.getTime() - dayOffset * DAY_MS);

      // Today: 3 requests, 1 verified, 2 failed verifications, 1 rate-limit block.
      await logRow('234803****01', 'requested', at(0));
      await logRow('234803****01', 'delivered-unknown', at(0));
      await logRow('234803****02', 'requested', at(0));
      await logRow('234803****01', 'verified', at(0), 1);
      await logRow('234803****02', 'failed', at(0), 2);
      await logRow('234803****02', 'failed', at(0), 3);
      await logRow('234803****03', 'rate-limited', at(0));
      // Two days ago: 2 requests (out of today's stats, inside the series window).
      await logRow('234803****04', 'requested', at(2));
      await logRow('234803****04', 'requested', at(2));
      // Well outside a 3-day window.
      await logRow('234803****05', 'requested', at(9));
    });

    it('stats counts only today and keeps deliverySuccessPct null (no provider receipts)', async () => {
      const res = await get('/admin/auth-monitor/stats');
      expect(res.status).toBe(200);
      expect(res.body.otpRequestsToday).toBe(3);
      expect(res.body.deliverySuccessPct).toBeNull();
      expect(res.body.failedVerificationsToday).toBe(2);
      expect(res.body.rateLimitBlocksToday).toBe(1);
    });

    it('series buckets request rows per day, oldest first, defaulting to 14 days', async () => {
      const res = await get('/admin/auth-monitor/series');
      expect(res.status).toBe(200);
      expect(res.body.counts).toHaveLength(14);
      expect(res.body.counts[13]).toBe(3); // today
      expect(res.body.counts[11]).toBe(2); // two days ago
      expect(res.body.counts[4]).toBe(1); // nine days ago
      expect(res.body.counts.reduce((a: number, b: number) => a + b, 0)).toBe(6);

      const start = new Date(`${res.body.startDate}T00:00:00.000Z`);
      const end = new Date(`${res.body.endDate}T00:00:00.000Z`);
      expect((end.getTime() - start.getTime()) / DAY_MS).toBe(13);
      expect(res.body.endDate).toBe(startOfUtcDay(new Date()).toISOString().slice(0, 10));
    });

    it('honours ?days and rejects out-of-range windows -> 422 VALIDATION_ERROR', async () => {
      const short = await get('/admin/auth-monitor/series', { days: 3 });
      expect(short.status).toBe(200);
      expect(short.body.counts).toEqual([2, 0, 3]);

      for (const days of [0, 91, 'abc']) {
        const res = await get('/admin/auth-monitor/series', { days });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('GET /admin/auth-monitor/requests (filters + paging)', () => {
    it('returns Paged<AdminOtpRequestView> newest first with masked phones only', async () => {
      const res = await get('/admin/auth-monitor/requests');
      expect(res.status).toBe(200);
      expect(res.body.page).toBe(1);
      expect(res.body.total).toBe(10);
      expect(res.body.data).toHaveLength(10);
      for (const row of res.body.data) {
        expect(Object.keys(row).sort()).toEqual([
          'attempts',
          'id',
          'outcome',
          'phoneMasked',
          'rateLimited',
          'requestedAt',
        ]);
        expect(typeof row.id).toBe('string');
        expect(new Date(row.requestedAt).toISOString()).toBe(row.requestedAt);
        expect(row.phoneMasked).toContain('*');
        expect([
          'requested',
          'delivered-unknown',
          'verified',
          'failed',
          'rate-limited',
        ]).toContain(row.outcome);
        expect(typeof row.attempts).toBe('number');
        expect(row.rateLimited).toBe(row.outcome === 'rate-limited');
      }

      const times = res.body.data.map((r: Record<string, string>) =>
        new Date(r.requestedAt).getTime(),
      );
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });

    it('filters by outcome', async () => {
      const res = await get('/admin/auth-monitor/requests', { outcome: 'failed' });
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      for (const row of res.body.data) {
        expect(row.outcome).toBe('failed');
        expect(row.rateLimited).toBe(false);
      }

      const limited = await get('/admin/auth-monitor/requests', { outcome: 'rate-limited' });
      expect(limited.body.total).toBe(1);
      expect(limited.body.data[0].rateLimited).toBe(true);
    });

    it('filters by phoneDigits within the masked digits', async () => {
      const res = await get('/admin/auth-monitor/requests', { phoneDigits: '01' });
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      for (const row of res.body.data) expect(row.phoneMasked).toBe('234803****01');

      const none = await get('/admin/auth-monitor/requests', { phoneDigits: '9999' });
      expect(none.body).toEqual({ data: [], page: 1, total: 0 });
    });

    it('combines filters and paginates by offset', async () => {
      const page1 = await get('/admin/auth-monitor/requests', {
        phoneDigits: '02',
        page: 1,
        limit: 2,
      });
      expect(page1.status).toBe(200);
      expect(page1.body.total).toBe(3);
      expect(page1.body.data).toHaveLength(2);

      const page2 = await get('/admin/auth-monitor/requests', {
        phoneDigits: '02',
        page: 2,
        limit: 2,
      });
      expect(page2.body.page).toBe(2);
      expect(page2.body.total).toBe(3);
      expect(page2.body.data).toHaveLength(1);
      const page1Ids = page1.body.data.map((r: Record<string, string>) => r.id);
      expect(page1Ids).not.toContain(page2.body.data[0].id);

      const combined = await get('/admin/auth-monitor/requests', {
        phoneDigits: '02',
        outcome: 'failed',
      });
      expect(combined.body.total).toBe(2);
    });

    it('rejects bad paging and an unknown outcome -> 422 VALIDATION_ERROR', async () => {
      const bad: Record<string, string | number>[] = [
        { page: 0 },
        { limit: 0 },
        { limit: 101 },
        { outcome: 'exploded' },
      ];
      for (const query of bad) {
        const res = await get('/admin/auth-monitor/requests', query);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('GET /admin/auth-monitor/test-numbers (superadmin, structural isTest filter)', () => {
    beforeAll(async () => {
      await prisma.business.createMany({
        data: [
          {
            id: TEST_BUSINESS,
            businessName: 'QA Sandbox Store',
            ownerName: 'QA Owner',
            phone: TEST_BUSINESS_PHONE,
            category: 'Retail',
            currency: 'NGN (₦)',
            reminderTone: 'friendly',
            isTest: true,
          },
          {
            id: REAL_BUSINESS,
            businessName: 'Mama Nkechi Provisions',
            ownerName: 'Nkechi',
            phone: REAL_BUSINESS_PHONE,
            category: 'Retail',
            currency: 'NGN (₦)',
            reminderTone: 'friendly',
            isTest: false,
          },
        ],
      });
      // A live code for the test business and one for the REAL business (must stay hidden).
      await prisma.otpCode.createMany({
        data: [
          {
            id: uuidv7(),
            phone: REAL_BUSINESS_PHONE,
            codeHash: 'hash-real',
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          },
        ],
      });
    });

    afterAll(async () => {
      await prisma.otpCode.deleteMany({});
      await prisma.business.deleteMany({ where: { id: { in: [TEST_BUSINESS, REAL_BUSINESS] } } });
    });

    it('lists ONLY test-flagged businesses and never a code', async () => {
      const res = await get('/admin/auth-monitor/test-numbers');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      const row = res.body[0];
      expect(Object.keys(row).sort()).toEqual([
        'businessId',
        'businessName',
        'expiresAt',
        'hasActiveCode',
        'phone',
      ]);
      expect(row.businessId).toBe(TEST_BUSINESS);
      expect(row.businessName).toBe('QA Sandbox Store');
      expect(row.phone).toBe(TEST_BUSINESS_PHONE);
      // No outstanding code yet for the test phone.
      expect(row.hasActiveCode).toBe(false);
      expect(row.expiresAt).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain(REAL_BUSINESS_PHONE);
      expect(JSON.stringify(res.body)).not.toContain('hash');
    });

    it('reports the live-code expiry state and ignores expired codes', async () => {
      const expired = new Date(Date.now() - 60 * 1000);
      await prisma.otpCode.create({
        data: {
          id: uuidv7(),
          phone: TEST_BUSINESS_PHONE,
          codeHash: 'hash-expired',
          expiresAt: expired,
        },
      });
      const stillNone = await get('/admin/auth-monitor/test-numbers');
      expect(stillNone.body[0].hasActiveCode).toBe(false);
      expect(stillNone.body[0].expiresAt).toBeNull();

      const live = new Date(Date.now() + 9 * 60 * 1000);
      await prisma.otpCode.create({
        data: {
          id: uuidv7(),
          phone: TEST_BUSINESS_PHONE,
          codeHash: 'hash-live',
          expiresAt: live,
        },
      });
      const res = await get('/admin/auth-monitor/test-numbers');
      expect(res.body[0].hasActiveCode).toBe(true);
      expect(res.body[0].expiresAt).toBe(live.toISOString());
    });
  });

  describe('GET /admin/auth-monitor/sessions (seeded)', () => {
    const BUSINESS = uuidv7();
    const STAFF = uuidv7();
    const chain: string[] = [uuidv7(), uuidv7(), uuidv7()];

    beforeAll(async () => {
      await prisma.refreshToken.deleteMany({});
      await prisma.business.create({
        data: {
          id: BUSINESS,
          businessName: 'Okoro Electronics',
          ownerName: 'Okoro',
          phone: '2348033330003',
          category: 'Retail',
          currency: 'NGN (₦)',
          reminderTone: 'friendly',
        },
      });
      await prisma.staff.create({
        data: { id: STAFF, businessId: BUSINESS, name: 'Okoro', phone: '2348033330003', role: 'owner' },
      });

      const future = new Date(Date.now() + 30 * DAY_MS);
      // Rotation chain: chain[0] -> chain[1] -> chain[2]; the first two are revoked.
      await prisma.refreshToken.createMany({
        data: [
          {
            id: chain[0],
            userId: STAFF,
            tokenHash: 'hash-0',
            rotatedFrom: null,
            revokedAt: new Date(Date.now() - 2 * DAY_MS),
            expiresAt: future,
          },
          {
            id: chain[1],
            userId: STAFF,
            tokenHash: 'hash-1',
            rotatedFrom: chain[0],
            revokedAt: new Date(Date.now() - 1 * DAY_MS),
            expiresAt: future,
          },
          { id: chain[2], userId: STAFF, tokenHash: 'hash-2', rotatedFrom: chain[1], expiresAt: future },
          // A second live session, and one revoked outside the 7-day window.
          { id: uuidv7(), userId: STAFF, tokenHash: 'hash-3', expiresAt: future },
          {
            id: uuidv7(),
            userId: STAFF,
            tokenHash: 'hash-4',
            revokedAt: new Date(Date.now() - 20 * DAY_MS),
            expiresAt: future,
          },
          // Expired but never revoked: not an active session.
          {
            id: uuidv7(),
            userId: STAFF,
            tokenHash: 'hash-5',
            expiresAt: new Date(Date.now() - DAY_MS),
          },
        ],
      });
    });

    afterAll(async () => {
      await prisma.refreshToken.deleteMany({});
      await prisma.staff.deleteMany({ where: { id: STAFF } });
      await prisma.business.deleteMany({ where: { id: BUSINESS } });
    });

    it('aggregates live sessions, revocations and rotation chains', async () => {
      const res = await get('/admin/auth-monitor/sessions');
      expect(res.status).toBe(200);
      expect(res.body.activeSessionCount).toBe(2);
      expect(res.body.revokedLast7d).toBe(2);
      // Nothing carries a revokedReason yet -> honest nulls, not zeros.
      expect(res.body.reuseIncidentsLast7d).toBeNull();
      expect(res.body.logoutRevocationsLast7d).toBeNull();

      const feed = res.body.recentRevocations;
      expect(feed.page).toBe(1);
      expect(feed.total).toBe(3);
      expect(feed.data).toHaveLength(3);
      for (const row of feed.data) {
        expect(Object.keys(row).sort()).toEqual([
          'businessName',
          'chainDepth',
          'expiresAt',
          'reason',
          'revokedAt',
          'staffId',
        ]);
        expect(row.staffId).toBe(STAFF);
        expect(row.businessName).toBe('Okoro Electronics');
        expect(new Date(row.revokedAt).toISOString()).toBe(row.revokedAt);
        expect(new Date(row.expiresAt).toISOString()).toBe(row.expiresAt);
        expect(row.reason).toBeNull();
      }
      // Newest revocation first: chain[1] (depth 1 behind chain[0]).
      expect(feed.data[0].chainDepth).toBe(1);
      expect(feed.data[1].chainDepth).toBe(0);
    });

    it('counts reuse and logout revocations once revokedReason is instrumented', async () => {
      await prisma.refreshToken.update({
        where: { id: chain[0] },
        data: { revokedReason: 'logout' },
      });
      await prisma.refreshToken.update({
        where: { id: chain[1] },
        data: { revokedReason: 'reuse' },
      });

      const res = await get('/admin/auth-monitor/sessions');
      expect(res.status).toBe(200);
      expect(res.body.reuseIncidentsLast7d).toBe(1);
      expect(res.body.logoutRevocationsLast7d).toBe(1);
      const reasons = res.body.recentRevocations.data.map((r: Record<string, string>) => r.reason);
      expect(reasons).toContain('reuse');
      expect(reasons).toContain('logout');

      await prisma.refreshToken.updateMany({ data: { revokedReason: null } });
    });

    it('paginates the revocation feed', async () => {
      const page1 = await get('/admin/auth-monitor/sessions', { page: 1, limit: 2 });
      expect(page1.status).toBe(200);
      expect(page1.body.recentRevocations.data).toHaveLength(2);
      expect(page1.body.recentRevocations.total).toBe(3);

      const page2 = await get('/admin/auth-monitor/sessions', { page: 2, limit: 2 });
      expect(page2.body.recentRevocations.page).toBe(2);
      expect(page2.body.recentRevocations.data).toHaveLength(1);
      // Aggregate counters are window-wide, not page-scoped.
      expect(page2.body.activeSessionCount).toBe(2);
      expect(page2.body.revokedLast7d).toBe(2);
    });

    it('rejects bad paging -> 422 VALIDATION_ERROR', async () => {
      const bad: Record<string, string | number>[] = [{ page: 0 }, { limit: 0 }, { limit: 101 }];
      for (const query of bad) {
        const res = await get('/admin/auth-monitor/sessions', query);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('read-only invariant', () => {
    it('exposes no write route -> 404 NOT_FOUND', async () => {
      const attempts: ['post' | 'put' | 'patch' | 'delete', string][] = [
        ['post', '/admin/auth-monitor/requests'],
        ['patch', '/admin/auth-monitor/stats'],
        ['put', '/admin/auth-monitor/sessions'],
        ['delete', '/admin/auth-monitor/test-numbers'],
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
