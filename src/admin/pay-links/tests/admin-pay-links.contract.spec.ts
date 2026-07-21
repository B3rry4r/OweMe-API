import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
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
import { ADMIN_ROLES_KEY, hashPassword } from '../../common';
import { AdminPayLinksModule } from '../admin-pay-links.module';
import { AdminPayLinksController } from '../admin-pay-links.controller';
import { AdminWebhookEventsController } from '../admin-webhook-events.controller';

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
 * AdminPayLinksView (contract). Same boot as app.module (global user guards,
 * ValidationPipe, HttpExceptionFilter) plus AdminModule (admin login), AuthModule
 * (a real user session for cross-rejection) and this resource's module, which the
 * integrator registers on AdminModule separately. Covers the derived fee split, the
 * month-parameterised aggregates, the webhook log including its empty state, the
 * filters, the offset pagination and the auth/role gates.
 */
describe('AdminPayLinksView (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sender = new SpyOtpSender();

  const ROOT_EMAIL = 'root-pay-links@oweme.app';
  const ROOT_PASSWORD = 'RootPass!2026';
  const SUPPORT_EMAIL = 'support-pay-links@oweme.app';
  const SUPPORT_PASSWORD = 'SupportPass!1';
  const USER_PHONE = '2348039990077';
  let rootAccess: string;
  let supportAccess: string;
  let userAccess: string;

  const BUSINESS_A = uuidv7(); // Mama Nkechi Provisions
  const BUSINESS_B = uuidv7(); // Okoro Electronics
  const CUSTOMER_A = uuidv7(); // Chidinma Eze
  const CUSTOMER_B = uuidv7(); // Bala
  const DEBT_A = uuidv7();
  const DEBT_B = uuidv7();

  const PAST_MONTH = '2026-03';
  const now = new Date();
  const CURRENT_MONTH = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  // Amounts chosen to exercise both fee formulas including their caps.
  const SMALL = 100_000; // N1,000   -> combined 12,500  commission 1,000
  const MID = 500_000; // N5,000   -> combined 22,500  commission 5,000
  const CAPPED = 20_000_000; // N200,000 -> combined capped 250,000, commission capped 50,000

  const login = async (email: string, password: string) =>
    request(app.getHttpServer()).post('/admin/auth/login').send({ email, password });

  const payments = async (query: Record<string, string | number> = {}, token = rootAccess) =>
    request(app.getHttpServer())
      .get('/admin/pay-links/payments')
      .query(query)
      .set('Authorization', `Bearer ${token}`);

  const stats = async (query: Record<string, string | number> = {}, token = rootAccess) =>
    request(app.getHttpServer())
      .get('/admin/pay-links/stats')
      .query(query)
      .set('Authorization', `Bearer ${token}`);

  const events = async (query: Record<string, string | number> = {}, token = rootAccess) =>
    request(app.getHttpServer())
      .get('/admin/webhooks/events')
      .query(query)
      .set('Authorization', `Bearer ${token}`);

  const expectPaymentShape = (p: Record<string, unknown>): void => {
    expect(Object.keys(p).sort()).toEqual([
      'amountKobo',
      'at',
      'businessName',
      'combinedFeeKobo',
      'commissionKobo',
      'debtorFirstName',
      'id',
      'processorShareKobo',
      'status',
    ]);
    expect(typeof p.id).toBe('string');
    expect(new Date(p.at as string).toISOString()).toBe(p.at);
    expect(typeof p.businessName).toBe('string');
    expect(typeof p.debtorFirstName).toBe('string');
    for (const key of ['amountKobo', 'combinedFeeKobo', 'commissionKobo', 'processorShareKobo']) {
      expect(Number.isInteger(p[key])).toBe(true);
    }
    expect(p.status).toBe('success');
  };

  const seedPayment = async (
    businessId: string,
    debtId: string,
    amount: number,
    method: string,
    createdAt: Date,
  ): Promise<string> => {
    const id = uuidv7();
    await prisma.payment.create({
      data: { id, businessId, debtId, amount, method, reference: `OWM-${id.slice(-5)}`, createdAt },
    });
    return id;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, AdminModule, AdminPayLinksModule, AuthModule],
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

    await prisma.payment.deleteMany({});
    await prisma.debt.deleteMany({});
    await prisma.customer.deleteMany({});
    await prisma.webhookEventLog.deleteMany({});
    await prisma.adminAuditLog.deleteMany({});
    await prisma.adminRefreshToken.deleteMany({});
    await prisma.adminUser.deleteMany({});

    for (const [email, name, role, password] of [
      [ROOT_EMAIL, 'Pay Links Root', 'superadmin', ROOT_PASSWORD],
      [SUPPORT_EMAIL, 'Pay Links Support', 'support', SUPPORT_PASSWORD],
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

    const otpReq = await request(app.getHttpServer())
      .post('/auth/request-otp')
      .send({ phone: USER_PHONE });
    expect(otpReq.status).toBe(202);
    const userSession = await request(app.getHttpServer())
      .post('/auth/verify-otp')
      .send({ phone: USER_PHONE, code: sender.codes.get(USER_PHONE)! });
    expect(userSession.status).toBe(200);
    userAccess = userSession.body.accessToken as string;

    for (const [id, businessName] of [
      [BUSINESS_A, 'Mama Nkechi Provisions'],
      [BUSINESS_B, 'Okoro Electronics'],
    ]) {
      await prisma.business.upsert({
        where: { id },
        update: {},
        create: {
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
    for (const [id, businessId, name] of [
      [CUSTOMER_A, BUSINESS_A, 'Chidinma Eze'],
      [CUSTOMER_B, BUSINESS_B, 'Bala'],
    ]) {
      await prisma.customer.create({
        data: { id, businessId, name, phone: '08030000000' },
      });
    }
    for (const [id, businessId, customerId] of [
      [DEBT_A, BUSINESS_A, CUSTOMER_A],
      [DEBT_B, BUSINESS_B, CUSTOMER_B],
    ]) {
      await prisma.debt.create({ data: { id, businessId, customerId, amount: CAPPED } });
    }
  });

  afterAll(async () => {
    await prisma.payment.deleteMany({});
    await prisma.debt.deleteMany({});
    await prisma.customer.deleteMany({});
    await prisma.business.deleteMany({ where: { id: { in: [BUSINESS_A, BUSINESS_B] } } });
    await app.close();
  });

  describe('empty tables read as honest zeros', () => {
    it('GET /admin/pay-links/payments -> empty page', async () => {
      const res = await payments();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [], page: 1, total: 0 });
    });

    it('GET /admin/pay-links/stats -> zeros for the current month', async () => {
      const res = await stats();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        settledCount: 0,
        volumeKobo: 0,
        feesChargedKobo: 0,
        commissionKeptKobo: 0,
        month: CURRENT_MONTH,
      });
    });

    it('GET /admin/webhooks/events -> empty page with errorCount 0', async () => {
      const res = await events();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [], page: 1, total: 0, errorCount: 0 });
    });
  });

  describe('GET /admin/pay-links/payments', () => {
    beforeAll(async () => {
      // Current month: three pay-link settlements plus one cash payment that must
      // never appear (the row set is Payment method 'Paystack link' only).
      await seedPayment(BUSINESS_A, DEBT_A, SMALL, 'Paystack link', new Date());
      await seedPayment(BUSINESS_B, DEBT_B, MID, 'Paystack link', new Date());
      await seedPayment(BUSINESS_A, DEBT_A, CAPPED, 'Paystack link', new Date());
      await seedPayment(BUSINESS_A, DEBT_A, 900_000, 'Cash', new Date());
      // A past month, so the month filter has something to exclude.
      await seedPayment(BUSINESS_B, DEBT_B, MID, 'Paystack link', new Date('2026-03-14T09:00:00Z'));
    });

    it('returns Paged<AdminPayLinkPaymentView> newest first, pay-link rows only', async () => {
      const res = await payments();
      expect(res.status).toBe(200);
      expect(res.body.page).toBe(1);
      expect(res.body.total).toBe(3);
      expect(res.body.data).toHaveLength(3);
      for (const row of res.body.data) expectPaymentShape(row);

      // Newest first: the capped row was seeded last of the three.
      expect(res.body.data[0].amountKobo).toBe(CAPPED);
      expect(res.body.data.map((r: Record<string, unknown>) => r.amountKobo)).not.toContain(900_000);
    });

    it('joins the business name and exposes the debtor FIRST name only', async () => {
      const res = await payments();
      const rowA = res.body.data.find(
        (r: Record<string, unknown>) => r.businessName === 'Mama Nkechi Provisions',
      );
      expect(rowA.debtorFirstName).toBe('Chidinma');
      const rowB = res.body.data.find(
        (r: Record<string, unknown>) => r.businessName === 'Okoro Electronics',
      );
      expect(rowB.debtorFirstName).toBe('Bala');
    });

    it('derives the fee split server-side from the live formulas, caps included', async () => {
      const res = await payments();
      const byAmount = new Map<number, Record<string, number>>(
        res.body.data.map((r: Record<string, number>) => [r.amountKobo, r]),
      );

      // N1,000: 2.5% + N100 = 12,500 combined; 1% = 1,000 commission.
      expect(byAmount.get(SMALL)).toMatchObject({
        combinedFeeKobo: 12_500,
        commissionKobo: 1_000,
        processorShareKobo: 11_500,
      });
      // N5,000: 12,500 + 10,000 = 22,500 combined; 5,000 commission.
      expect(byAmount.get(MID)).toMatchObject({
        combinedFeeKobo: 22_500,
        commissionKobo: 5_000,
        processorShareKobo: 17_500,
      });
      // N200,000: combined capped at N2,500 and commission capped at N500.
      expect(byAmount.get(CAPPED)).toMatchObject({
        combinedFeeKobo: 250_000,
        commissionKobo: 50_000,
        processorShareKobo: 200_000,
      });
      // Nothing derived is persisted: Payment keeps amount/method/reference only.
      const stored = await prisma.payment.findFirst({ where: { amount: CAPPED } });
      expect(Object.keys(stored!)).not.toContain('combinedFee');
    });

    it('filters by month (YYYY-MM), defaulting to the current month', async () => {
      const past = await payments({ month: PAST_MONTH });
      expect(past.status).toBe(200);
      expect(past.body.total).toBe(1);
      expect(past.body.data[0].businessName).toBe('Okoro Electronics');
      expect(past.body.data[0].at.startsWith('2026-03')).toBe(true);

      const quiet = await payments({ month: '2020-01' });
      expect(quiet.status).toBe(200);
      expect(quiet.body).toEqual({ data: [], page: 1, total: 0 });

      const current = await payments({ month: CURRENT_MONTH });
      expect(current.body.total).toBe(3);
    });

    it('paginates by offset with a stable order', async () => {
      const page1 = await payments({ page: 1, limit: 2 });
      expect(page1.status).toBe(200);
      expect(page1.body).toMatchObject({ page: 1, total: 3 });
      expect(page1.body.data).toHaveLength(2);

      const page2 = await payments({ page: 2, limit: 2 });
      expect(page2.body).toMatchObject({ page: 2, total: 3 });
      expect(page2.body.data).toHaveLength(1);

      const ids = page1.body.data.map((r: Record<string, unknown>) => r.id);
      expect(ids).not.toContain(page2.body.data[0].id);
    });

    it('rejects out-of-range paging and malformed month -> 422 VALIDATION_ERROR', async () => {
      const badQueries: Record<string, string | number>[] = [
        { page: 0 },
        { limit: 0 },
        { limit: 101 },
        { month: '2026-13' },
      ];
      for (const query of badQueries) {
        const res = await payments(query);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('GET /admin/pay-links/stats', () => {
    it('aggregates the current month per row (caps applied per payment)', async () => {
      const res = await stats();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        settledCount: 3,
        volumeKobo: SMALL + MID + CAPPED,
        feesChargedKobo: 12_500 + 22_500 + 250_000,
        commissionKeptKobo: 1_000 + 5_000 + 50_000,
        month: CURRENT_MONTH,
      });
    });

    it('is month parameterised and echoes the month back', async () => {
      const past = await stats({ month: PAST_MONTH });
      expect(past.status).toBe(200);
      expect(past.body).toEqual({
        settledCount: 1,
        volumeKobo: MID,
        feesChargedKobo: 22_500,
        commissionKeptKobo: 5_000,
        month: PAST_MONTH,
      });

      const quiet = await stats({ month: '2020-01' });
      expect(quiet.body).toEqual({
        settledCount: 0,
        volumeKobo: 0,
        feesChargedKobo: 0,
        commissionKeptKobo: 0,
        month: '2020-01',
      });
    });

    it('rejects a malformed month -> 422 VALIDATION_ERROR', async () => {
      const res = await stats({ month: 'July' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /admin/webhooks/events', () => {
    beforeAll(async () => {
      const rows: [string, string, string | null, string, object | null][] = [
        ['paystack', 'charge.success', 'PAYL_0001', 'ok', null],
        ['paystack', 'charge.success', 'PAYL_0002', 'error', { reason: 'debt not found' }],
        ['paystack', 'transfer.failed', 'PAYL_0003', 'ignored', null],
        ['iap', 'SUBSCRIBED', null, 'ok', null],
        ['iap', 'DID_FAIL_TO_RENEW', 'iap-9', 'error', { reason: 'receipt invalid' }],
      ];
      let tick = 0;
      for (const [source, eventType, reference, outcome, detail] of rows) {
        await prisma.webhookEventLog.create({
          data: {
            id: uuidv7(),
            source,
            eventType,
            reference,
            outcome,
            detail: detail ?? undefined,
            createdAt: new Date(Date.UTC(2026, 6, 10, 0, 0, tick++)),
          },
        });
      }
    });

    it('returns Paged<AdminWebhookEventView> newest first plus errorCount', async () => {
      const res = await events();
      expect(res.status).toBe(200);
      expect(res.body.page).toBe(1);
      expect(res.body.total).toBe(5);
      expect(res.body.errorCount).toBe(2);
      expect(res.body.data).toHaveLength(5);
      expect(res.body.data[0].eventType).toBe('DID_FAIL_TO_RENEW');

      for (const row of res.body.data) {
        expect(Object.keys(row).sort()).toEqual([
          'at',
          'detail',
          'eventType',
          'id',
          'outcome',
          'reference',
          'source',
        ]);
        expect(new Date(row.at).toISOString()).toBe(row.at);
        expect(['paystack', 'iap']).toContain(row.source);
        expect(['ok', 'ignored', 'error']).toContain(row.outcome);
        expect(row.reference === null || typeof row.reference === 'string').toBe(true);
        expect(row.detail === null || typeof row.detail === 'object').toBe(true);
      }

      const failed = res.body.data.find((r: Record<string, unknown>) => r.reference === 'PAYL_0002');
      expect(failed.detail).toEqual({ reason: 'debt not found' });
    });

    it('filters by source and by outcome, and both together', async () => {
      const paystack = await events({ source: 'paystack' });
      expect(paystack.status).toBe(200);
      expect(paystack.body.total).toBe(3);

      const errors = await events({ outcome: 'error' });
      expect(errors.body.total).toBe(2);

      const both = await events({ source: 'iap', outcome: 'error' });
      expect(both.body.total).toBe(1);
      expect(both.body.data[0].eventType).toBe('DID_FAIL_TO_RENEW');
    });

    it('keeps errorCount UNFILTERED for the section subtitle', async () => {
      const filtered = await events({ source: 'paystack', outcome: 'ok' });
      expect(filtered.body.total).toBe(1);
      expect(filtered.body.errorCount).toBe(2);
    });

    it('paginates by offset', async () => {
      const page1 = await events({ page: 1, limit: 3 });
      expect(page1.body.data).toHaveLength(3);
      expect(page1.body).toMatchObject({ page: 1, total: 5, errorCount: 2 });

      const page2 = await events({ page: 2, limit: 3 });
      expect(page2.body.data).toHaveLength(2);
      expect(page2.body.page).toBe(2);

      const ids = page1.body.data.map((r: Record<string, unknown>) => r.id);
      for (const row of page2.body.data) expect(ids).not.toContain(row.id);
    });

    it('rejects unknown source/outcome values and bad paging -> 422', async () => {
      const badQueries: Record<string, string | number>[] = [
        { source: 'stripe' },
        { outcome: 'pending' },
        { page: 0 },
        { limit: 101 },
      ];
      for (const query of badQueries) {
        const res = await events(query);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('auth and role gates', () => {
    const paths = ['/admin/pay-links/payments', '/admin/pay-links/stats', '/admin/webhooks/events'];

    it('no token -> 401 UNAUTHENTICATED on every endpoint', async () => {
      for (const path of paths) {
        const res = await request(app.getHttpServer()).get(path);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('garbage token -> 401 on every endpoint', async () => {
      for (const path of paths) {
        const res = await request(app.getHttpServer())
          .get(path)
          .set('Authorization', 'Bearer not-a-token');
        expect(res.status).toBe(401);
      }
    });

    it('a valid USER access token is rejected -> 401', async () => {
      const userMe = await request(app.getHttpServer())
        .get('/me')
        .set('Authorization', `Bearer ${userAccess}`);
      expect(userMe.status).toBe(200);

      for (const path of paths) {
        const res = await request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${userAccess}`);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('support reads every endpoint per the registry role list', async () => {
      expect((await payments({}, supportAccess)).status).toBe(200);
      expect((await stats({}, supportAccess)).status).toBe(200);
      expect((await events({}, supportAccess)).status).toBe(200);
    });

    it('declares exactly the registry roles on both controllers', () => {
      const reflector = app.get(Reflector);
      for (const controller of [AdminPayLinksController, AdminWebhookEventsController]) {
        expect(reflector.get(ADMIN_ROLES_KEY, controller)).toEqual(['superadmin', 'support']);
      }
    });

    it('is read-only: no write route exists -> 404 NOT_FOUND', async () => {
      const attempts: ['post' | 'put' | 'patch' | 'delete', string][] = [
        ['post', '/admin/pay-links/payments'],
        ['patch', '/admin/pay-links/stats'],
        ['delete', '/admin/webhooks/events'],
      ];
      for (const [method, path] of attempts) {
        const res = await request(app.getHttpServer())
          [method](path)
          .set('Authorization', `Bearer ${rootAccess}`);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
    });

    it('records no audit rows: the whole resource is a read surface', async () => {
      const writes = await prisma.adminAuditLog.count({
        where: { actionType: { not: 'login' } },
      });
      expect(writes).toBe(0);
    });
  });
});
