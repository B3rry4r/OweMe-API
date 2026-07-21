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
import { AdminDebtsModule } from '../admin-debts.module';

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

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number): Date => new Date(Date.now() - days * DAY);
const ahead = (days: number): Date => new Date(Date.now() + days * DAY);
const inCurrentMonth = (at: Date): boolean => {
  const now = new Date();
  return (
    at.getUTCFullYear() === now.getUTCFullYear() && at.getUTCMonth() === now.getUTCMonth()
  );
};

/**
 * AdminDebtsView (contract). Same boot as app.module (global user guards,
 * ValidationPipe, HttpExceptionFilter) plus AdminModule (admin login) and the
 * AdminDebtsModule under test; AuthModule joins so the user-token rejection is
 * proven against a REAL user session. Covers the empty-table reads, the derived
 * status vocabulary, minimised customer identity, remindersSent, daysToRecovery,
 * the month-relative stats, the payments feed, filters, paging and the role gates.
 */
describe('AdminDebtsView (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sender = new SpyOtpSender();

  const ROOT_EMAIL = 'root-debts@oweme.app';
  const ROOT_PASSWORD = 'RootPass!2026';
  const SUPPORT_EMAIL = 'support-debts@oweme.app';
  const SUPPORT_PASSWORD = 'SupportPass!1';
  const USER_PHONE = '2348039990077';
  let rootAccess: string;
  let supportAccess: string;

  const BUSINESS_A = uuidv7(); // Mama Nkechi Provisions
  const BUSINESS_B = uuidv7(); // Okoro Electronics
  const CUSTOMER_CHIDI = uuidv7();
  const CUSTOMER_NGOZI = uuidv7();
  const CUSTOMER_EMEKA = uuidv7();
  const DEBT_OPEN = uuidv7();
  const DEBT_PARTIAL = uuidv7();
  const DEBT_OVERDUE = uuidv7();
  const DEBT_PAID = uuidv7();
  const DEBT_ARCHIVED = uuidv7();

  const PAYMENT_PARTIAL_AT = ago(2);
  const PAYMENT_FIRST_AT = ago(5);
  const PAYMENT_SETTLING_AT = ago(3);

  const login = async (email: string, password: string) =>
    request(app.getHttpServer()).post('/admin/auth/login').send({ email, password });

  const listDebts = async (
    query: Record<string, string | number> = {},
    token: string = rootAccess,
  ) =>
    request(app.getHttpServer())
      .get('/admin/debts')
      .query(query)
      .set('Authorization', `Bearer ${token}`);

  const statsCall = async (token: string = rootAccess) =>
    request(app.getHttpServer()).get('/admin/debts/stats').set('Authorization', `Bearer ${token}`);

  const listPayments = async (
    query: Record<string, string | number> = {},
    token: string = rootAccess,
  ) =>
    request(app.getHttpServer())
      .get('/admin/payments')
      .query(query)
      .set('Authorization', `Bearer ${token}`);

  const expectDebtShape = (d: Record<string, unknown>): void => {
    expect(typeof d.id).toBe('string');
    expect(typeof d.businessName).toBe('string');
    expect(typeof d.customerFirstName).toBe('string');
    expect(typeof d.customerPhoneMasked).toBe('string');
    expect(typeof d.amountKobo).toBe('number');
    expect(typeof d.remainingKobo).toBe('number');
    expect(d.dueDate === null || typeof d.dueDate === 'string').toBe(true);
    expect(['open', 'partial', 'overdue', 'paid', 'archived']).toContain(d.status);
    expect(typeof d.remindersSent).toBe('number');
    expect(d.daysToRecovery === null || typeof d.daysToRecovery === 'number').toBe(true);
    expect(Object.keys(d).sort()).toEqual([
      'amountKobo',
      'businessName',
      'customerFirstName',
      'customerPhoneMasked',
      'daysToRecovery',
      'dueDate',
      'id',
      'remainingKobo',
      'remindersSent',
      'status',
    ]);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, AdminModule, AdminDebtsModule, AuthModule],
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

    // These reads are cross-tenant, so the spec owns the whole debt ledger.
    await prisma.payment.deleteMany({});
    await prisma.reminder.deleteMany({});
    await prisma.debt.deleteMany({});
    await prisma.customer.deleteMany({});
    await prisma.adminAuditLog.deleteMany({});
    await prisma.adminRefreshToken.deleteMany({});
    await prisma.adminUser.deleteMany({});

    for (const [email, name, role, password] of [
      [ROOT_EMAIL, 'Debts Root', 'superadmin', ROOT_PASSWORD],
      [SUPPORT_EMAIL, 'Debts Support', 'support', SUPPORT_PASSWORD],
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
    await prisma.payment.deleteMany({});
    await prisma.reminder.deleteMany({});
    await prisma.debt.deleteMany({});
    await prisma.customer.deleteMany({});
    await prisma.business.deleteMany({ where: { id: { in: [BUSINESS_A, BUSINESS_B] } } });
    await app.close();
  });

  describe('empty ledger', () => {
    it('GET /admin/debts reads gracefully with no debts', async () => {
      const res = await listDebts();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [], page: 1, total: 0 });
    });

    it('GET /admin/debts/stats returns honest zeros and a null average', async () => {
      const res = await statsCall();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        openRemainingKobo: 0,
        recoveredThisMonthKobo: 0,
        overdueDebtCount: 0,
        avgDaysToRecovery: null,
      });
    });

    it('GET /admin/payments reads gracefully with no payments', async () => {
      const res = await listPayments();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [], page: 1, total: 0 });
    });
  });

  describe('seeded ledger', () => {
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

      for (const [id, businessId, name, phone] of [
        [CUSTOMER_CHIDI, BUSINESS_A, 'Chidi Okeke', '2348031112222'],
        [CUSTOMER_NGOZI, BUSINESS_A, 'Ngozi Bello', '2348039994444'],
        [CUSTOMER_EMEKA, BUSINESS_B, 'Emeka Uche', '2348055556666'],
      ]) {
        await prisma.customer.create({ data: { id, businessId, name, phone } });
      }

      // Newest first at the top of the list: DEBT_OPEN is the most recent row.
      await prisma.debt.create({
        data: {
          id: DEBT_ARCHIVED,
          businessId: BUSINESS_A,
          customerId: CUSTOMER_CHIDI,
          amount: 100_000,
          createdAt: ago(30),
          deleted: true,
        },
      });
      await prisma.debt.create({
        data: {
          id: DEBT_PAID,
          businessId: BUSINESS_B,
          customerId: CUSTOMER_EMEKA,
          amount: 200_000,
          createdAt: ago(10),
        },
      });
      await prisma.debt.create({
        data: {
          id: DEBT_OVERDUE,
          businessId: BUSINESS_B,
          customerId: CUSTOMER_EMEKA,
          amount: 300_000,
          createdAt: ago(8),
          dueDate: ago(4),
        },
      });
      await prisma.debt.create({
        data: {
          id: DEBT_PARTIAL,
          businessId: BUSINESS_A,
          customerId: CUSTOMER_NGOZI,
          amount: 400_000,
          createdAt: ago(6),
          dueDate: ahead(10),
        },
      });
      await prisma.debt.create({
        data: {
          id: DEBT_OPEN,
          businessId: BUSINESS_A,
          customerId: CUSTOMER_CHIDI,
          amount: 500_000,
          createdAt: ago(1),
          dueDate: ahead(20),
        },
      });

      // DEBT_PAID settles on its SECOND payment: 10 days old, settled 3 days ago -> 7.
      await prisma.payment.create({
        data: {
          id: uuidv7(),
          businessId: BUSINESS_B,
          debtId: DEBT_PAID,
          amount: 50_000,
          method: 'Cash',
          reference: 'OWM-00001',
          createdAt: PAYMENT_FIRST_AT,
        },
      });
      await prisma.payment.create({
        data: {
          id: uuidv7(),
          businessId: BUSINESS_B,
          debtId: DEBT_PAID,
          amount: 150_000,
          method: 'Paystack link',
          reference: 'OWM-00002',
          createdAt: PAYMENT_SETTLING_AT,
        },
      });
      await prisma.payment.create({
        data: {
          id: uuidv7(),
          businessId: BUSINESS_A,
          debtId: DEBT_PARTIAL,
          amount: 100_000,
          method: 'Bank transfer to GTB',
          reference: 'OWM-00003',
          createdAt: PAYMENT_PARTIAL_AT,
        },
      });

      for (const status of ['sent', 'sent']) {
        await prisma.reminder.create({
          data: {
            id: uuidv7(),
            businessId: BUSINESS_A,
            debtId: DEBT_OPEN,
            channel: 'sms',
            status,
            sentAt: ago(1),
          },
        });
      }
      await prisma.reminder.create({
        data: {
          id: uuidv7(),
          businessId: BUSINESS_B,
          debtId: DEBT_OVERDUE,
          channel: 'whatsapp',
          status: 'failed',
        },
      });
    });

    describe('GET /admin/debts', () => {
      it('returns Paged<AdminDebtView> newest first with business + minimised customer', async () => {
        const res = await listDebts();
        expect(res.status).toBe(200);
        expect(res.body.page).toBe(1);
        // Archived rows are excluded unless explicitly asked for.
        expect(res.body.total).toBe(4);
        expect(res.body.data).toHaveLength(4);
        for (const debt of res.body.data) expectDebtShape(debt);

        const first = res.body.data[0];
        expect(first.id).toBe(DEBT_OPEN);
        expect(first.businessName).toBe('Mama Nkechi Provisions');
        expect(first.customerFirstName).toBe('Chidi');
        expect(first.customerPhoneMasked).toBe('*********2222');
        expect(first.amountKobo).toBe(500_000);
        expect(first.remainingKobo).toBe(500_000);
        expect(first.status).toBe('open');
        expect(first.remindersSent).toBe(2);
        expect(first.daysToRecovery).toBeNull();
        expect(typeof first.dueDate).toBe('string');
        expect(new Date(first.dueDate).toISOString()).toBe(first.dueDate);

        expect(res.body.data.map((d: Record<string, unknown>) => d.id)).toEqual([
          DEBT_OPEN,
          DEBT_PARTIAL,
          DEBT_OVERDUE,
          DEBT_PAID,
        ]);
      });

      it('derives partial, overdue and paid money + status from the payment table', async () => {
        const res = await listDebts();
        const byId = new Map<string, Record<string, unknown>>(
          res.body.data.map((d: Record<string, unknown>) => [d.id as string, d]),
        );

        const partial = byId.get(DEBT_PARTIAL)!;
        expect(partial.status).toBe('partial');
        expect(partial.remainingKobo).toBe(300_000);
        expect(partial.customerFirstName).toBe('Ngozi');
        expect(partial.daysToRecovery).toBeNull();
        expect(partial.remindersSent).toBe(0);

        const overdue = byId.get(DEBT_OVERDUE)!;
        expect(overdue.status).toBe('overdue');
        expect(overdue.remainingKobo).toBe(300_000);
        expect(overdue.businessName).toBe('Okoro Electronics');
        expect(overdue.remindersSent).toBe(1);

        const paid = byId.get(DEBT_PAID)!;
        expect(paid.status).toBe('paid');
        expect(paid.remainingKobo).toBe(0);
        // Settling payment 3 days ago on a debt created 10 days ago.
        expect(paid.daysToRecovery).toBe(7);
        expect(paid.dueDate).toBeNull();
      });

      it('never leaks a full customer name or phone', async () => {
        const res = await listDebts();
        const serialized = JSON.stringify(res.body);
        expect(serialized).not.toContain('Okeke');
        expect(serialized).not.toContain('2348031112222');
        expect(serialized).not.toContain('8031112222');
      });

      it('filters by each derived status', async () => {
        const cases: [string, string[]][] = [
          ['open', [DEBT_OPEN]],
          ['partial', [DEBT_PARTIAL]],
          ['overdue', [DEBT_OVERDUE]],
          ['paid', [DEBT_PAID]],
          ['archived', [DEBT_ARCHIVED]],
        ];
        for (const [status, expected] of cases) {
          const res = await listDebts({ status });
          expect(res.status).toBe(200);
          expect(res.body.total).toBe(expected.length);
          expect(res.body.data.map((d: Record<string, unknown>) => d.id)).toEqual(expected);
          for (const debt of res.body.data) expect(debt.status).toBe(status);
        }
      });

      it('searches business name or customer name', async () => {
        const byBusiness = await listDebts({ search: 'Okoro' });
        expect(byBusiness.status).toBe(200);
        expect(byBusiness.body.total).toBe(2);
        expect(byBusiness.body.data.map((d: Record<string, unknown>) => d.id).sort()).toEqual(
          [DEBT_OVERDUE, DEBT_PAID].sort(),
        );

        const byCustomer = await listDebts({ search: 'Ngozi' });
        expect(byCustomer.status).toBe(200);
        expect(byCustomer.body.total).toBe(1);
        expect(byCustomer.body.data[0].id).toBe(DEBT_PARTIAL);

        const combined = await listDebts({ search: 'Okoro', status: 'paid' });
        expect(combined.status).toBe(200);
        expect(combined.body.total).toBe(1);
        expect(combined.body.data[0].id).toBe(DEBT_PAID);

        const none = await listDebts({ search: 'No Such Shop' });
        expect(none.status).toBe(200);
        expect(none.body).toEqual({ data: [], page: 1, total: 0 });
      });

      it('paginates by offset with a stable order', async () => {
        const page1 = await listDebts({ page: 1, limit: 3 });
        expect(page1.status).toBe(200);
        expect(page1.body).toMatchObject({ page: 1, total: 4 });
        expect(page1.body.data).toHaveLength(3);

        const page2 = await listDebts({ page: 2, limit: 3 });
        expect(page2.body).toMatchObject({ page: 2, total: 4 });
        expect(page2.body.data).toHaveLength(1);
        expect(page2.body.data[0].id).toBe(DEBT_PAID);

        const beyond = await listDebts({ page: 9, limit: 3 });
        expect(beyond.status).toBe(200);
        expect(beyond.body).toEqual({ data: [], page: 9, total: 4 });
      });

      it('rejects out-of-range paging and an unknown status -> 422 VALIDATION_ERROR', async () => {
        const badQueries: Record<string, string | number>[] = [
          { limit: 0 },
          { limit: 101 },
          { page: 0 },
          { status: 'settled' },
          { unknown: 'x' },
        ];
        for (const query of badQueries) {
          const res = await listDebts(query);
          expect(res.status).toBe(422);
          expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
      });
    });

    describe('GET /admin/debts/stats', () => {
      it('aggregates open, overdue and recovery figures month-relative', async () => {
        const res = await statsCall();
        expect(res.status).toBe(200);
        // Archived is out of the ledger; the paid debt contributes nothing open.
        expect(res.body.openRemainingKobo).toBe(500_000 + 300_000 + 300_000);
        expect(res.body.overdueDebtCount).toBe(1);
        expect(res.body.avgDaysToRecovery).toBe(7);

        // Month window resolved server-side: only the seeded payments that fall in
        // the CURRENT calendar month count.
        const expected = [
          [PAYMENT_FIRST_AT, 50_000],
          [PAYMENT_SETTLING_AT, 150_000],
          [PAYMENT_PARTIAL_AT, 100_000],
        ]
          .filter(([at]) => inCurrentMonth(at as Date))
          .reduce((sum, [, amount]) => sum + (amount as number), 0);
        expect(res.body.recoveredThisMonthKobo).toBe(expected);

        const now = new Date();
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const older = await prisma.payment.count({ where: { createdAt: { lt: monthStart } } });
        // When a seeded payment fell into last month the window really excluded it.
        if (older > 0) expect(res.body.recoveredThisMonthKobo).toBeLessThan(300_000);
      });
    });

    describe('GET /admin/payments', () => {
      it('returns Paged<AdminPaymentView> newest first with the method verbatim', async () => {
        const res = await listPayments();
        expect(res.status).toBe(200);
        expect(res.body.page).toBe(1);
        expect(res.body.total).toBe(3);
        expect(res.body.data).toHaveLength(3);
        for (const payment of res.body.data) {
          expect(Object.keys(payment).sort()).toEqual([
            'amountKobo',
            'businessName',
            'id',
            'method',
            'paidAt',
          ]);
          expect(new Date(payment.paidAt).toISOString()).toBe(payment.paidAt);
        }

        const newest = res.body.data[0];
        expect(newest.amountKobo).toBe(100_000);
        expect(newest.businessName).toBe('Mama Nkechi Provisions');
        // Free-text client label, untouched by the server.
        expect(newest.method).toBe('Bank transfer to GTB');
        expect(res.body.data.map((p: Record<string, unknown>) => p.method)).toEqual([
          'Bank transfer to GTB',
          'Paystack link',
          'Cash',
        ]);
      });

      it('paginates by offset', async () => {
        const page1 = await listPayments({ page: 1, limit: 2 });
        expect(page1.status).toBe(200);
        expect(page1.body).toMatchObject({ page: 1, total: 3 });
        expect(page1.body.data).toHaveLength(2);

        const page2 = await listPayments({ page: 2, limit: 2 });
        expect(page2.body).toMatchObject({ page: 2, total: 3 });
        expect(page2.body.data).toHaveLength(1);
        expect(page2.body.data[0].method).toBe('Cash');
      });

      it('rejects out-of-range paging -> 422 VALIDATION_ERROR', async () => {
        const badQueries: Record<string, string | number>[] = [
          { limit: 0 },
          { limit: 101 },
          { page: 0 },
        ];
        for (const query of badQueries) {
          const res = await listPayments(query);
          expect(res.status).toBe(422);
          expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
      });
    });

    describe('auth + role gates (superadmin + support per registry)', () => {
      const paths = ['/admin/debts', '/admin/debts/stats', '/admin/payments'];

      it('support reads every endpoint', async () => {
        expect((await listDebts({}, supportAccess)).status).toBe(200);
        expect((await statsCall(supportAccess)).status).toBe(200);
        expect((await listPayments({}, supportAccess)).status).toBe(200);
      });

      it('no token -> 401 UNAUTHENTICATED; garbage token -> 401', async () => {
        for (const path of paths) {
          const noAuth = await request(app.getHttpServer()).get(path);
          expect(noAuth.status).toBe(401);
          expect(noAuth.body.error.code).toBe('UNAUTHENTICATED');

          const garbage = await request(app.getHttpServer())
            .get(path)
            .set('Authorization', 'Bearer not-a-token');
          expect(garbage.status).toBe(401);
        }
      });

      it('a valid USER access token is rejected on the admin surface', async () => {
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
          const res = await request(app.getHttpServer())
            .get(path)
            .set('Authorization', `Bearer ${session.body.accessToken}`);
          expect(res.status).toBe(401);
          expect(res.body.error.code).toBe('UNAUTHENTICATED');
        }
      });
    });

    describe('read-only invariant', () => {
      it('exposes no write route -> 404 NOT_FOUND', async () => {
        const attempts: ['post' | 'put' | 'patch' | 'delete', string][] = [
          ['post', '/admin/debts'],
          ['patch', `/admin/debts/${DEBT_OPEN}`],
          ['delete', `/admin/debts/${DEBT_OPEN}`],
          ['post', '/admin/payments'],
          ['delete', '/admin/payments'],
        ];
        for (const [method, path] of attempts) {
          const res = await request(app.getHttpServer())
            [method](path)
            .set('Authorization', `Bearer ${rootAccess}`);
          expect(res.status).toBe(404);
          expect(res.body.error.code).toBe('NOT_FOUND');
        }
        expect(await prisma.debt.count()).toBe(5);
        expect(await prisma.payment.count()).toBe(3);
      });
    });
  });
});
