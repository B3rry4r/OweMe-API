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
import { AdminAiUsageModule } from '../admin-ai-usage.module';

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
 * AdminAiUsageView (contract). Same boot as app.module (global user guards,
 * ValidationPipe, HttpExceptionFilter) plus AdminAuthModule (to mint admin sessions),
 * the user AuthModule (to mint a real user session for cross-rejection) and the
 * resource module under test. Covers the four readers against BOTH the empty
 * usage_events table and seeded data, the honest nulls (on-device share, model spend),
 * filters, offset paging and the superadmin+support role gate.
 */
describe('AdminAiUsageView (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sender = new SpyOtpSender();

  const ROOT_EMAIL = 'root-ai-usage@oweme.app';
  const ROOT_PASSWORD = 'RootPass!2026';
  const SUPPORT_EMAIL = 'support-ai-usage@oweme.app';
  const SUPPORT_PASSWORD = 'SupportPass!1';
  const USER_PHONE = '2348039990077';
  let rootAccess: string;
  let supportAccess: string;

  const BUSINESS_A = uuidv7(); // Mama Nkechi Provisions, market plan
  const BUSINESS_B = uuidv7(); // Okoro Electronics, business plan
  const ORPHAN_BUSINESS = uuidv7(); // deliberately has NO Business row

  const PATHS = [
    '/admin/ai-usage/stats',
    '/admin/ai-usage/series',
    '/admin/ai-usage/by-business',
    '/admin/ai-usage/recent-parses',
  ];

  const get = async (
    path: string,
    query: Record<string, string | number> = {},
    token: string = rootAccess,
  ) =>
    request(app.getHttpServer())
      .get(path)
      .query(query)
      .set('Authorization', `Bearer ${token}`);

  const login = async (email: string, password: string) =>
    request(app.getHttpServer()).post('/admin/auth/login').send({ email, password });

  const monthKey = (at: Date): string =>
    `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;

  /** Monday 00:00 UTC of the week containing `at` (mirrors the service). */
  const weekStart = (at: Date): Date => {
    const midnight = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    return new Date(midnight.getTime() - ((midnight.getUTCDay() + 6) % 7) * 24 * 60 * 60 * 1000);
  };

  const seedEvent = async (
    businessId: string,
    type: string,
    credits: number,
    costKoboEstimate: number | null,
    meta: object | null,
    createdAt: Date,
  ): Promise<string> => {
    const id = uuidv7();
    await prisma.usageEvent.create({
      data: { id, businessId, type, credits, costKoboEstimate, meta: meta ?? undefined, createdAt },
    });
    return id;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, AdminAuthModule, AdminAiUsageModule, AuthModule],
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

    await prisma.usageEvent.deleteMany({});
    await prisma.adminRefreshToken.deleteMany({});
    await prisma.adminUser.deleteMany({});
    for (const [email, name, role, password] of [
      [ROOT_EMAIL, 'AI Root', 'superadmin', ROOT_PASSWORD],
      [SUPPORT_EMAIL, 'AI Support', 'support', SUPPORT_PASSWORD],
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

    for (const [id, businessName, plan] of [
      [BUSINESS_A, 'Mama Nkechi Provisions', 'market'],
      [BUSINESS_B, 'Okoro Electronics', 'business'],
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
    await prisma.business.deleteMany({ where: { id: { in: [BUSINESS_A, BUSINESS_B] } } });
    await app.close();
  });

  describe('empty usage_events table (instrumentation not yet landed)', () => {
    it('GET /admin/ai-usage/stats -> honest zeros and nulls, never an error', async () => {
      const res = await get('/admin/ai-usage/stats');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        parsesTotal: 0,
        fallbackParses: 0,
        onDeviceParses: null,
        onDeviceSharePct: null,
        modelSpendEstimateKobo: null,
        periodMonth: monthKey(new Date()),
      });
    });

    it('GET /admin/ai-usage/series -> 12 all-zero points', async () => {
      const res = await get('/admin/ai-usage/series');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(12);
      for (const point of res.body) {
        expect(point.parses).toBe(0);
        expect(point.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it('GET /admin/ai-usage/by-business and /recent-parses -> empty paged envelopes', async () => {
      for (const path of ['/admin/ai-usage/by-business', '/admin/ai-usage/recent-parses']) {
        const res = await get(path);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ data: [], page: 1, total: 0 });
      }
    });
  });

  describe('with seeded usage_events', () => {
    let parseIds: string[];

    beforeAll(async () => {
      // Anchor inside BOTH the current calendar month and the current Monday-started
      // week so month-scoped and week-scoped assertions are date-independent.
      const now = new Date();
      const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
      const base = Math.max(monthStart, weekStart(now).getTime()) + 60 * 60 * 1000;
      const at = (minutes: number) => new Date(base + minutes * 60 * 1000);
      // 60 days back is guaranteed to be a previous calendar month and an earlier week,
      // while staying inside the default 12-week series window.
      const longAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

      parseIds = [
        await seedEvent(BUSINESS_A, 'voiceParse', 1, 120, { outcome: 'parsed' }, at(1)),
        await seedEvent(BUSINESS_A, 'voiceParse', 1, null, { outcome: 'low-confidence' }, at(2)),
        await seedEvent(BUSINESS_A, 'voiceParse', 1, null, null, at(3)),
        await seedEvent(BUSINESS_B, 'voiceParse', 1, 80, { outcome: 'error' }, at(4)),
        await seedEvent(ORPHAN_BUSINESS, 'voiceParse', 1, null, { outcome: 'parsed' }, at(5)),
      ];
      await seedEvent(BUSINESS_A, 'insight', 4, null, { kind: 'risk' }, at(3));
      // Neither a parse nor an insight: must be invisible to every endpoint here.
      await seedEvent(BUSINESS_A, 'send', 5, 400, { reminderId: 'r-1' }, at(2));
      // Previous month: counted by the series window, excluded from the monthly rollups.
      await seedEvent(BUSINESS_B, 'voiceParse', 1, null, { outcome: 'parsed' }, longAgo);
    });

    describe('GET /admin/ai-usage/stats', () => {
      it('counts this month voiceParse only, fallback == total, on-device null', async () => {
        const res = await get('/admin/ai-usage/stats');
        expect(res.status).toBe(200);
        expect(res.body.parsesTotal).toBe(5);
        // The backend only ever sees fallback parses.
        expect(res.body.fallbackParses).toBe(5);
        expect(res.body.onDeviceParses).toBeNull();
        expect(res.body.onDeviceSharePct).toBeNull();
        expect(res.body.periodMonth).toBe(monthKey(new Date()));
      });

      it('sums costKoboEstimate over the rows that recorded one', async () => {
        const res = await get('/admin/ai-usage/stats');
        expect(res.body.modelSpendEstimateKobo).toBe(200);
      });
    });

    describe('GET /admin/ai-usage/series', () => {
      it('buckets parses into Monday-started weeks, oldest first', async () => {
        const res = await get('/admin/ai-usage/series');
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(12);

        const current = weekStart(new Date()).toISOString().slice(0, 10);
        const last = res.body[res.body.length - 1];
        expect(last.weekStart).toBe(current);
        expect(last.parses).toBe(5);

        const totals = res.body.reduce(
          (sum: number, p: { parses: number }) => sum + p.parses,
          0,
        );
        expect(totals).toBe(6); // the 60-day-old parse falls in an earlier bucket

        const starts = res.body.map((p: { weekStart: string }) => p.weekStart);
        expect([...starts].sort()).toEqual(starts);
      });

      it('honors ?weeks and drops rows older than the window', async () => {
        const res = await get('/admin/ai-usage/series', { weeks: 4 });
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(4);
        const totals = res.body.reduce(
          (sum: number, p: { parses: number }) => sum + p.parses,
          0,
        );
        expect(totals).toBe(5);

        const one = await get('/admin/ai-usage/series', { weeks: 1 });
        expect(one.body).toHaveLength(1);
        expect(one.body[0].parses).toBe(5);
      });

      it('rejects out-of-range weeks -> 422 VALIDATION_ERROR', async () => {
        for (const weeks of [0, 53, -1]) {
          const res = await get('/admin/ai-usage/series', { weeks });
          expect(res.status).toBe(422);
          expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
      });
    });

    describe('GET /admin/ai-usage/by-business', () => {
      it('rolls up this month by business, parses desc, insights and credits summed', async () => {
        const res = await get('/admin/ai-usage/by-business');
        expect(res.status).toBe(200);
        expect(res.body.page).toBe(1);
        expect(res.body.total).toBe(2);
        expect(res.body.data).toHaveLength(2);

        const [first, second] = res.body.data;
        expect(first).toEqual({
          businessId: BUSINESS_A,
          businessName: 'Mama Nkechi Provisions',
          plan: 'market',
          parses: 3,
          onDevicePct: null,
          insights: 1,
          creditsDebited: 7, // 3 parses at 1 credit + 1 insight at 4; the send row is excluded
        });
        expect(second).toEqual({
          businessId: BUSINESS_B,
          businessName: 'Okoro Electronics',
          plan: 'business',
          parses: 1,
          onDevicePct: null,
          insights: 0,
          creditsDebited: 1,
        });
        // The parse whose Business row is gone cannot be rendered with a name or plan.
        const ids = res.body.data.map((r: { businessId: string }) => r.businessId);
        expect(ids).not.toContain(ORPHAN_BUSINESS);
      });

      it('filters by plan', async () => {
        const res = await get('/admin/ai-usage/by-business', { plan: 'business' });
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(1);
        expect(res.body.data[0].businessId).toBe(BUSINESS_B);

        const none = await get('/admin/ai-usage/by-business', { plan: 'starter' });
        expect(none.status).toBe(200);
        expect(none.body).toEqual({ data: [], page: 1, total: 0 });
      });

      it('paginates by offset', async () => {
        const page1 = await get('/admin/ai-usage/by-business', { page: 1, limit: 1 });
        expect(page1.status).toBe(200);
        expect(page1.body).toMatchObject({ page: 1, total: 2 });
        expect(page1.body.data).toHaveLength(1);
        expect(page1.body.data[0].businessId).toBe(BUSINESS_A);

        const page2 = await get('/admin/ai-usage/by-business', { page: 2, limit: 1 });
        expect(page2.body).toMatchObject({ page: 2, total: 2 });
        expect(page2.body.data).toHaveLength(1);
        expect(page2.body.data[0].businessId).toBe(BUSINESS_B);

        const page3 = await get('/admin/ai-usage/by-business', { page: 3, limit: 1 });
        expect(page3.body).toEqual({ data: [], page: 3, total: 2 });
      });

      it('rejects out-of-range paging and unknown plans -> 422 VALIDATION_ERROR', async () => {
        const bad: Record<string, string | number>[] = [
          { limit: 0 },
          { limit: 51 },
          { page: 0 },
          { plan: 'platinum' },
        ];
        for (const query of bad) {
          const res = await get('/admin/ai-usage/by-business', query);
          expect(res.status).toBe(422);
          expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
      });
    });

    describe('GET /admin/ai-usage/recent-parses', () => {
      it('returns metadata-only rows newest first, across months', async () => {
        const res = await get('/admin/ai-usage/recent-parses');
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(6);
        expect(res.body.data).toHaveLength(6);

        const newest = res.body.data[0];
        expect(Object.keys(newest).sort()).toEqual([
          'at',
          'businessId',
          'businessName',
          'creditsCharged',
          'id',
          'outcome',
        ]);
        // Transcripts are never stored and can never surface here.
        expect(JSON.stringify(res.body)).not.toContain('transcript');

        expect(newest.id).toBe(parseIds[4]);
        expect(newest.businessId).toBe(ORPHAN_BUSINESS);
        expect(newest.businessName).toBe('Unknown business');
        expect(newest.outcome).toBe('parsed');
        expect(newest.creditsCharged).toBe(1);
        expect(new Date(newest.at as string).toISOString()).toBe(newest.at);

        const times = res.body.data.map((r: { at: string }) => r.at);
        expect([...times].sort().reverse()).toEqual(times);

        const named = res.body.data.find(
          (r: { id: string }) => r.id === parseIds[3],
        );
        expect(named.businessName).toBe('Okoro Electronics');
        expect(named.outcome).toBe('error');
      });

      it('falls back to an honest outcome when the row recorded no meta', async () => {
        const res = await get('/admin/ai-usage/recent-parses');
        const noMeta = res.body.data.find((r: { id: string }) => r.id === parseIds[2]);
        expect(noMeta.outcome).toBe('unknown');
        expect(noMeta.businessName).toBe('Mama Nkechi Provisions');
      });

      it('paginates by offset with a stable order', async () => {
        const page1 = await get('/admin/ai-usage/recent-parses', { page: 1, limit: 4 });
        expect(page1.body.data).toHaveLength(4);
        expect(page1.body).toMatchObject({ page: 1, total: 6 });

        const page2 = await get('/admin/ai-usage/recent-parses', { page: 2, limit: 4 });
        expect(page2.body.data).toHaveLength(2);
        expect(page2.body).toMatchObject({ page: 2, total: 6 });

        const page1Ids = page1.body.data.map((r: { id: string }) => r.id);
        for (const row of page2.body.data) expect(page1Ids).not.toContain(row.id);
      });

      it('rejects out-of-range paging -> 422 VALIDATION_ERROR', async () => {
        const bad: Record<string, string | number>[] = [{ limit: 0 }, { limit: 51 }, { page: 0 }];
        for (const query of bad) {
          const res = await get('/admin/ai-usage/recent-parses', query);
          expect(res.status).toBe(422);
          expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
      });
    });

    describe('auth and role gate (superadmin + support per registry)', () => {
      it('no token -> 401 UNAUTHENTICATED on every endpoint', async () => {
        for (const path of PATHS) {
          const res = await request(app.getHttpServer()).get(path);
          expect(res.status).toBe(401);
          expect(res.body.error.code).toBe('UNAUTHENTICATED');
        }
      });

      it('garbage token -> 401', async () => {
        for (const path of PATHS) {
          const res = await request(app.getHttpServer())
            .get(path)
            .set('Authorization', 'Bearer not-a-token');
          expect(res.status).toBe(401);
        }
      });

      it('a valid USER access token is rejected on the admin surface -> 401', async () => {
        const otpReq = await request(app.getHttpServer())
          .post('/auth/request-otp')
          .send({ phone: USER_PHONE });
        expect(otpReq.status).toBe(202);
        const code = sender.codes.get(USER_PHONE)!;
        const session = await request(app.getHttpServer())
          .post('/auth/verify-otp')
          .send({ phone: USER_PHONE, code });
        expect(session.status).toBe(200);

        for (const path of PATHS) {
          const res = await request(app.getHttpServer())
            .get(path)
            .set('Authorization', `Bearer ${session.body.accessToken}`);
          expect(res.status).toBe(401);
          expect(res.body.error.code).toBe('UNAUTHENTICATED');
        }
      });

      it('support and superadmin both read every endpoint', async () => {
        for (const path of PATHS) {
          expect((await get(path, {}, supportAccess)).status).toBe(200);
          expect((await get(path, {}, rootAccess)).status).toBe(200);
        }
      });
    });

    describe('read-only surface', () => {
      it('exposes no write route -> 404 NOT_FOUND', async () => {
        const attempts: ['post' | 'put' | 'patch' | 'delete', string][] = [
          ['post', '/admin/ai-usage/stats'],
          ['post', '/admin/ai-usage/recent-parses'],
          ['delete', `/admin/ai-usage/recent-parses/${parseIds[0]}`],
          ['patch', '/admin/ai-usage/by-business'],
        ];
        for (const [method, path] of attempts) {
          const res = await request(app.getHttpServer())
            [method](path)
            .set('Authorization', `Bearer ${rootAccess}`);
          expect(res.status).toBe(404);
          expect(res.body.error.code).toBe('NOT_FOUND');
        }
        expect(await prisma.usageEvent.count()).toBe(8);
      });
    });
  });
});
