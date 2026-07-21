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
import { CREDIT_WEIGHTS } from '../../../usage/credit-ledger.service';
import { AdminAuthModule } from '../../auth/admin-auth.module';
import { hashPassword } from '../../common';
import { AdminRemindersModule } from '../admin-reminders.module';

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
 * AdminRemindersView (contract). Same boot as app.module (global user guards,
 * ValidationPipe, HttpExceptionFilter) plus admin auth and this resource. Covers
 * the honest-empty reads (zero reminders, zero usage_events), the seeded month
 * stats, the paged/filtered monitor list, the weekly SMS cost sparkline, and the
 * auth + role gates from the registry (superadmin AND support may read).
 */
describe('AdminRemindersView (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sender = new SpyOtpSender();

  const ROOT_EMAIL = 'root-reminders@oweme.app';
  const ROOT_PASSWORD = 'RootPass!2026';
  const SUPPORT_EMAIL = 'support-reminders@oweme.app';
  const SUPPORT_PASSWORD = 'SupportPass!1';
  const USER_PHONE = '2348039990077';
  let rootAccess: string;
  let supportAccess: string;
  let userAccess: string;

  const BUSINESS_A = uuidv7(); // Mama Nkechi Provisions
  const BUSINESS_B = uuidv7(); // Okoro Electronics
  const CUSTOMER_A = uuidv7();
  const CUSTOMER_B = uuidv7();
  const DEBT_A = uuidv7();
  const DEBT_B = uuidv7();

  const now = new Date();
  const MONTH = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  /** Safely inside the current month regardless of when the suite runs. */
  const inMonth = new Date(monthStart.getTime() + 6 * 60 * 60 * 1000);
  /** Always in the previous calendar month AND never in the same week as inMonth. */
  const lastMonth = new Date(monthStart.getTime() - 15 * 24 * 60 * 60 * 1000);

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

  const seedReminder = async (
    businessId: string,
    debtId: string,
    channel: string,
    status: string,
    dates: { scheduledFor?: Date; sentAt?: Date; createdAt: Date },
  ): Promise<string> => {
    const id = uuidv7();
    await prisma.reminder.create({
      data: {
        id,
        businessId,
        debtId,
        channel,
        status,
        scheduledFor: dates.scheduledFor ?? null,
        sentAt: dates.sentAt ?? null,
        createdAt: dates.createdAt,
      },
    });
    return id;
  };

  const seedUsageEvent = async (
    businessId: string,
    costKoboEstimate: number | null,
    createdAt: Date,
    type = 'send',
  ): Promise<void> => {
    await prisma.usageEvent.create({
      data: {
        id: uuidv7(),
        businessId,
        type,
        credits: CREDIT_WEIGHTS.reminderSend,
        costKoboEstimate,
        createdAt,
      },
    });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CommonModule,
        AuthModule,
        AdminAuthModule,
        AdminRemindersModule,
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

    await prisma.reminder.deleteMany({});
    await prisma.usageEvent.deleteMany({});
    await prisma.adminAuditLog.deleteMany({});
    await prisma.adminRefreshToken.deleteMany({});
    await prisma.adminUser.deleteMany({});

    for (const [email, name, role, password] of [
      [ROOT_EMAIL, 'Reminders Root', 'superadmin', ROOT_PASSWORD],
      [SUPPORT_EMAIL, 'Reminders Support', 'support', SUPPORT_PASSWORD],
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

    // A REAL user session, to prove a user token cannot read the admin surface.
    await request(app.getHttpServer()).post('/auth/request-otp').send({ phone: USER_PHONE });
    const userSession = await request(app.getHttpServer())
      .post('/auth/verify-otp')
      .send({ phone: USER_PHONE, code: sender.codes.get(USER_PHONE)! });
    userAccess = userSession.body.accessToken as string;
  });

  afterAll(async () => {
    await prisma.reminder.deleteMany({});
    await prisma.usageEvent.deleteMany({});
    await prisma.debt.deleteMany({ where: { id: { in: [DEBT_A, DEBT_B] } } });
    await prisma.customer.deleteMany({ where: { id: { in: [CUSTOMER_A, CUSTOMER_B] } } });
    await prisma.business.deleteMany({ where: { id: { in: [BUSINESS_A, BUSINESS_B] } } });
    await app.close();
  });

  describe('auth gate', () => {
    it('no token -> 401 UNAUTHENTICATED on every endpoint', async () => {
      for (const path of [
        '/admin/reminders',
        '/admin/reminders/stats',
        '/admin/reminders/sms-cost-series',
      ]) {
        const res = await request(app.getHttpServer()).get(path);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('garbage token and a valid USER token -> 401 on every endpoint', async () => {
      for (const token of ['not-a-token', userAccess]) {
        for (const path of [
          '/admin/reminders',
          '/admin/reminders/stats',
          '/admin/reminders/sms-cost-series',
        ]) {
          const res = await request(app.getHttpServer())
            .get(path)
            .set('Authorization', `Bearer ${token}`);
          expect(res.status).toBe(401);
          expect(res.body.error.code).toBe('UNAUTHENTICATED');
        }
      }
    });
  });

  describe('empty tables (zero reminders, zero usage_events)', () => {
    it('GET /admin/reminders returns an empty page, never an error', async () => {
      const res = await get('/admin/reminders');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [], page: 1, total: 0 });
    });

    it('GET /admin/reminders/stats returns honest zeros and nulls', async () => {
      const res = await get('/admin/reminders/stats');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sendsThisMonth: 0,
        deliveredThisMonth: null,
        smsSendsThisMonth: 0,
        smsCostThisMonthKobo: null,
        creditsPerSend: CREDIT_WEIGHTS.reminderSend,
        month: MONTH,
      });
    });

    it('GET /admin/reminders/sms-cost-series returns all-null points', async () => {
      const res = await get('/admin/reminders/sms-cost-series');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(12);
      for (const point of res.body) {
        expect(point.costPerSmsAvgKobo).toBeNull();
        expect(point.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });
  });

  describe('seeded reads', () => {
    beforeAll(async () => {
      for (const [id, businessName] of [
        [BUSINESS_A, 'Mama Nkechi Provisions'],
        [BUSINESS_B, 'Okoro Electronics'],
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
      for (const [id, businessId] of [
        [CUSTOMER_A, BUSINESS_A],
        [CUSTOMER_B, BUSINESS_B],
      ]) {
        await prisma.customer.create({
          data: { id, businessId, name: 'Chidi', phone: '08030000000' },
        });
      }
      for (const [id, businessId, customerId] of [
        [DEBT_A, BUSINESS_A, CUSTOMER_A],
        [DEBT_B, BUSINESS_B, CUSTOMER_B],
      ]) {
        await prisma.debt.create({ data: { id, businessId, customerId, amount: 500000 } });
      }

      // 3 sends this month (2 sms + 1 whatsapp), 1 sms send LAST month (excluded),
      // 1 scheduled and 1 failed row that are not sends at all.
      await seedReminder(BUSINESS_A, DEBT_A, 'sms', 'sent', {
        sentAt: inMonth,
        createdAt: inMonth,
      });
      await seedReminder(BUSINESS_B, DEBT_B, 'sms', 'sent', {
        sentAt: inMonth,
        createdAt: inMonth,
      });
      await seedReminder(BUSINESS_A, DEBT_A, 'whatsapp', 'sent', {
        sentAt: inMonth,
        createdAt: inMonth,
      });
      await seedReminder(BUSINESS_A, DEBT_A, 'sms', 'sent', {
        sentAt: lastMonth,
        createdAt: lastMonth,
      });
      await seedReminder(BUSINESS_B, DEBT_B, 'sms', 'scheduled', {
        scheduledFor: inMonth,
        createdAt: inMonth,
      });
      await seedReminder(BUSINESS_A, DEBT_A, 'call', 'failed', { createdAt: inMonth });

      // Priced usage: 300 + 400 kobo this month, 900 kobo last month (excluded),
      // one uncosted row and one non-send row that must never move the numbers.
      await seedUsageEvent(BUSINESS_A, 300, inMonth);
      await seedUsageEvent(BUSINESS_B, 400, inMonth);
      await seedUsageEvent(BUSINESS_A, 900, lastMonth);
      await seedUsageEvent(BUSINESS_A, null, inMonth);
      await seedUsageEvent(BUSINESS_A, 5000, inMonth, 'voiceParse');
    });

    it('GET /admin/reminders/stats counts sends and sums SMS cost for this month only', async () => {
      const res = await get('/admin/reminders/stats');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sendsThisMonth: 3,
        deliveredThisMonth: null,
        smsSendsThisMonth: 2,
        smsCostThisMonthKobo: 700,
        creditsPerSend: CREDIT_WEIGHTS.reminderSend,
        month: MONTH,
      });
    });

    it('GET /admin/reminders returns Paged<AdminReminderView> newest first', async () => {
      const res = await get('/admin/reminders');
      expect(res.status).toBe(200);
      expect(res.body.page).toBe(1);
      expect(res.body.total).toBe(6);
      expect(res.body.data).toHaveLength(6);

      for (const row of res.body.data) {
        expect(Object.keys(row).sort()).toEqual([
          'businessName',
          'channel',
          'costKoboEstimate',
          'id',
          'scheduledFor',
          'sentAt',
          'status',
          'step',
        ]);
        expect(['Mama Nkechi Provisions', 'Okoro Electronics']).toContain(row.businessName);
        expect(['sms', 'whatsapp', 'call', 'manual', 'printable']).toContain(row.channel);
        expect(['scheduled', 'sent', 'failed']).toContain(row.status);
        // Not stored / not instrumented: honest nulls per the registry.
        expect(row.step).toBeNull();
        expect(row.costKoboEstimate).toBeNull();
        for (const key of ['scheduledFor', 'sentAt']) {
          expect(row[key] === null || new Date(row[key]).toISOString() === row[key]).toBe(true);
        }
      }

      const failed = res.body.data.find((r: Record<string, unknown>) => r.status === 'failed');
      expect(failed.channel).toBe('call');
      expect(failed.sentAt).toBeNull();
      expect(failed.businessName).toBe('Mama Nkechi Provisions');

      const scheduled = res.body.data.find(
        (r: Record<string, unknown>) => r.status === 'scheduled',
      );
      expect(scheduled.businessName).toBe('Okoro Electronics');
      expect(scheduled.scheduledFor).toBe(inMonth.toISOString());
      expect(scheduled.sentAt).toBeNull();
    });

    it('filters by channel and by status, and ANDs nothing away wrongly', async () => {
      const sms = await get('/admin/reminders', { channel: 'sms' });
      expect(sms.status).toBe(200);
      expect(sms.body.total).toBe(4);
      for (const row of sms.body.data) expect(row.channel).toBe('sms');

      const sent = await get('/admin/reminders', { status: 'sent' });
      expect(sent.status).toBe(200);
      expect(sent.body.total).toBe(4);
      for (const row of sent.body.data) expect(row.status).toBe('sent');

      const both = await get('/admin/reminders', { channel: 'sms', status: 'sent' });
      expect(both.status).toBe(200);
      expect(both.body.total).toBe(3);

      const none = await get('/admin/reminders', { channel: 'printable' });
      expect(none.status).toBe(200);
      expect(none.body).toEqual({ data: [], page: 1, total: 0 });
    });

    it('paginates by offset with a stable order', async () => {
      const page1 = await get('/admin/reminders', { page: 1, limit: 4 });
      expect(page1.status).toBe(200);
      expect(page1.body.data).toHaveLength(4);
      expect(page1.body.total).toBe(6);

      const page2 = await get('/admin/reminders', { page: 2, limit: 4 });
      expect(page2.status).toBe(200);
      expect(page2.body.page).toBe(2);
      expect(page2.body.data).toHaveLength(2);
      expect(page2.body.total).toBe(6);

      const page1Ids = page1.body.data.map((r: Record<string, unknown>) => r.id);
      for (const row of page2.body.data) expect(page1Ids).not.toContain(row.id);

      const beyond = await get('/admin/reminders', { page: 99, limit: 4 });
      expect(beyond.status).toBe(200);
      expect(beyond.body).toEqual({ data: [], page: 99, total: 6 });
    });

    it('rejects out-of-range paging and unknown filter values -> 422', async () => {
      const badQueries: Record<string, string | number>[] = [
        { page: 0 },
        { limit: 0 },
        { limit: 101 },
        { channel: 'telegram' },
        { status: 'delivered' },
      ];
      for (const query of badQueries) {
        const res = await get('/admin/reminders', query);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('GET /admin/reminders/sms-cost-series averages priced send rows per week', async () => {
      const res = await get('/admin/reminders/sms-cost-series');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(12);

      // Weeks are Monday-aligned, oldest first, and strictly consecutive.
      for (let i = 1; i < res.body.length; i += 1) {
        const previous = new Date(`${res.body[i - 1].weekStart}T00:00:00.000Z`).getTime();
        const current = new Date(`${res.body[i].weekStart}T00:00:00.000Z`).getTime();
        expect(current - previous).toBe(7 * 24 * 60 * 60 * 1000);
        expect(new Date(`${res.body[i].weekStart}T00:00:00.000Z`).getUTCDay()).toBe(1);
      }

      const mondayOf = (at: Date): string =>
        new Date(
          Date.UTC(
            at.getUTCFullYear(),
            at.getUTCMonth(),
            at.getUTCDate() - ((at.getUTCDay() + 6) % 7),
          ),
        )
          .toISOString()
          .slice(0, 10);

      // The 300 + 400 rows sit in the inMonth week; the uncosted row and the
      // voiceParse row are excluded, so that week averages to 350.
      const inMonthWeek = res.body.find(
        (p: Record<string, unknown>) => p.weekStart === mondayOf(inMonth),
      );
      expect(inMonthWeek).toBeDefined();
      expect(inMonthWeek.costPerSmsAvgKobo).toBe(350);

      // The prior-month row lives in its own earlier bucket, untouched by the above.
      const lastMonthWeek = res.body.find(
        (p: Record<string, unknown>) => p.weekStart === mondayOf(lastMonth),
      );
      expect(lastMonthWeek).toBeDefined();
      expect(lastMonthWeek.costPerSmsAvgKobo).toBe(900);

      // Every other bucket is honestly empty rather than zero-filled.
      const priced = res.body.filter(
        (p: Record<string, unknown>) => p.costPerSmsAvgKobo !== null,
      );
      expect(priced).toHaveLength(2);
    });

    it('honors ?weeks= and rejects out-of-range values -> 422', async () => {
      const one = await get('/admin/reminders/sms-cost-series', { weeks: 1 });
      expect(one.status).toBe(200);
      expect(one.body).toHaveLength(1);

      const many = await get('/admin/reminders/sms-cost-series', { weeks: 52 });
      expect(many.status).toBe(200);
      expect(many.body).toHaveLength(52);

      for (const weeks of [0, 105]) {
        const res = await get('/admin/reminders/sms-cost-series', { weeks });
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('role gate (registry: superadmin AND support may read)', () => {
    it('support reads all three endpoints', async () => {
      const list = await get('/admin/reminders', {}, supportAccess);
      expect(list.status).toBe(200);
      expect(list.body.total).toBe(6);

      const stats = await get('/admin/reminders/stats', {}, supportAccess);
      expect(stats.status).toBe(200);
      expect(stats.body.month).toBe(MONTH);

      const series = await get('/admin/reminders/sms-cost-series', {}, supportAccess);
      expect(series.status).toBe(200);
      expect(series.body).toHaveLength(12);
    });

    it('a disabled admin loses access immediately -> 401', async () => {
      await prisma.adminUser.update({
        where: { email: SUPPORT_EMAIL },
        data: { status: 'disabled' },
      });
      const res = await get('/admin/reminders', {}, supportAccess);
      expect(res.status).toBe(401);
      await prisma.adminUser.update({
        where: { email: SUPPORT_EMAIL },
        data: { status: 'active' },
      });
    });
  });

  describe('read-only surface', () => {
    it('exposes no write route -> 404 NOT_FOUND', async () => {
      const attempts: ['post' | 'put' | 'patch' | 'delete', string][] = [
        ['post', '/admin/reminders'],
        ['patch', `/admin/reminders/${uuidv7()}`],
        ['delete', `/admin/reminders/${uuidv7()}`],
      ];
      for (const [method, path] of attempts) {
        const res = await request(app.getHttpServer())
          [method](path)
          .set('Authorization', `Bearer ${rootAccess}`);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
      expect(await prisma.reminder.count()).toBe(6);
    });
  });
});
