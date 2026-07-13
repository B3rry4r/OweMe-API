import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { createHmac } from 'crypto';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  PAYSTACK_GATEWAY,
  RECEIPT_VERIFIER,
  LLM_PROVIDER,
  OTP_SENDER,
  MESSAGE_SENDER,
} from '../src/common/providers/tokens';
import { hashOtpCode } from '../src/auth/auth.crypto';
import { Role } from '../src/shared';

/**
 * INTEGRATION SMOKE (Phase 7). Boots the WHOLE AppModule (every feature module registered)
 * with the SAME global ValidationPipe + HttpExceptionFilter + rawBody as main.ts, against a
 * fresh migrated + seeded DB. Seeds ONE tenant (Business + owner Staff + staff Staff + a
 * customer/debt/payment/reminder/notification), mints owner + staff JWTs with the real
 * JWT_ACCESS_SECRET, overrides the provider stubs with deterministic fakes, then hits EVERY
 * endpoint in .pipeline/registry.json — asserting the contracted status + response SHAPE,
 * plus cross-cutting guard behaviour (no-token 401, wrong-role 403, webhook signature).
 *
 * This is the cross-module integration net: it catches route collisions, global guard/filter
 * interactions, provider wiring and module-import problems the isolated per-module contract
 * tests cannot see.
 */

const PAYSTACK_SECRET = 'smoke-paystack-webhook-secret';
const sign = (raw: string): string =>
  createHmac('sha512', PAYSTACK_SECRET).update(raw).digest('hex');

// Deterministic HMAC Paystack gateway (default stub accepts any signature — can't prove reject).
const hmacPaystackGateway = {
  listBanks: async () => [
    { code: '044', name: 'Access Bank' },
    { code: '058', name: 'Guaranty Trust Bank' },
  ],
  resolveAccount: async (_b: string, accountNumber: string) => ({
    accountName: `TEST ACCOUNT ${accountNumber}`,
  }),
  createSubaccount: async (input: { accountNumber: string }) => ({
    subaccountCode: `ACCT_${input.accountNumber}`,
  }),
  createPaymentRequest: async (input: { reference: string }) => ({
    url: `https://paystack.test/pay/${input.reference}`,
    reference: input.reference,
  }),
  verifySignature: (rawBody: Buffer | string, signature: string): boolean => {
    const expected = createHmac('sha512', PAYSTACK_SECRET)
      .update(typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody)
      .digest('hex');
    return !!signature && signature === expected;
  },
};

// IAP verifier: always valid; txn id keyed on the receipt (idempotency probe).
const stubReceiptVerifier = {
  verify: async (input: { productId: string; receipt: string }) => ({
    valid: true,
    transactionId: `smoke-txn-${input.receipt}`,
    productId: input.productId,
  }),
};

// LLM: deterministic parse fixture so /voice/parse returns representative data.
const stubLlm = {
  parseVoiceDebt: async () => ({
    customerName: 'Amaka Trader',
    amount: 250000,
    description: 'engine oil',
    dueDate: null,
  }),
  generateInsights: async () => ({}),
  scoreCustomerRisk: async () => ({ score: 0, band: 'unknown' }),
};

const stubOtp = { sendOtp: async () => undefined };
const stubMessage = {
  send: async () => ({ providerMessageId: 'smoke-msg', accepted: true }),
};

describe('Integration smoke (full AppModule, every registry endpoint)', () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let jwt: JwtService;

  const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret';

  // ── tenant ────────────────────────────────────────────────────────────────
  const BID = 'smoke-biz-0001';
  const OWNER_ID = 'smoke-owner-0001';
  const STAFF_ID = 'smoke-staff-0001';

  // domain fixtures
  const CUST = 'smoke-cust-0001';
  const CUST_DEL = 'smoke-cust-del-1'; // throwaway for DELETE /customers/:id
  const DEBT = 'smoke-debt-0001'; // primary read fixture (dueDate set, partially paid)
  const DEBT_DEL = 'smoke-debt-del-1'; // throwaway for DELETE + restore
  const DEBT_PAY = 'smoke-debt-pay-1'; // throwaway for payment create + undo
  const DEBT_DELC = 'smoke-debt-delc-1'; // debt under CUST_DEL
  const PAY = 'smoke-pay-0001';
  const REM = 'smoke-rem-0001';
  const REM_FAILED = 'smoke-rem-failed-1';
  const NOTIF = 'smoke-notif-0001';

  const DAY = 24 * 60 * 60 * 1000;

  const mint = (role: Role, sub: string, businessId: string | null = BID): string =>
    jwt.sign({ sub, businessId, role }, { secret: JWT_SECRET, expiresIn: '1h' });

  let ownerToken: string;
  let staffToken: string;
  const owner = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${ownerToken}`);
  const staff = (r: request.Test): request.Test => r.set('Authorization', `Bearer ${staffToken}`);

  const expectErrorEnvelope = (body: Record<string, unknown>, code?: string): void => {
    expect(body).toHaveProperty('error');
    const err = body.error as Record<string, unknown>;
    expect(typeof err.code).toBe('string');
    expect(typeof err.message).toBe('string');
    if (code) expect(err.code).toBe(code);
  };

  const expectPaginated = (body: Record<string, unknown>): void => {
    expect(Array.isArray(body.data)).toBe(true);
    expect('nextCursor' in body).toBe(true);
    expect(body.nextCursor === null || typeof body.nextCursor === 'string').toBe(true);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PAYSTACK_GATEWAY)
      .useValue(hmacPaystackGateway)
      .overrideProvider(RECEIPT_VERIFIER)
      .useValue(stubReceiptVerifier)
      .overrideProvider(LLM_PROVIDER)
      .useValue(stubLlm)
      .overrideProvider(OTP_SENDER)
      .useValue(stubOtp)
      .overrideProvider(MESSAGE_SENDER)
      .useValue(stubMessage)
      .compile();

    // rawBody: true — mirror main.ts exactly (Paystack HMAC over exact bytes).
    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    await app.init();
    http = app.getHttpServer();

    // ── seed one tenant + representative rows ────────────────────────────────
    await prisma.business.upsert({
      where: { id: BID },
      create: {
        id: BID,
        businessName: 'Smoke Traders',
        ownerName: 'Ada Owner',
        phone: '08030000000',
        category: 'Retail',
        currency: 'NGN (₦)',
        reminderTone: 'gentle',
        plan: 'business', // rev 2: 5 staff seats, 1,200 credits/month, ₦6M BVUM ceiling
        paystackSubaccount: 'ACCT_smoke_0001',
      },
      update: { plan: 'business', paystackSubaccount: 'ACCT_smoke_0001' },
    });

    await prisma.staff.upsert({
      where: { id: OWNER_ID },
      create: { id: OWNER_ID, businessId: BID, name: 'Ada Owner', phone: '08030000000', role: 'owner' },
      update: {},
    });
    await prisma.staff.upsert({
      where: { id: STAFF_ID },
      create: { id: STAFF_ID, businessId: BID, name: 'Bola Staff', phone: '08031111111', role: 'staff' },
      update: {},
    });

    const now = Date.now();

    for (const [id, name, phone] of [
      [CUST, 'Amaka Customer', '08111111111'],
      [CUST_DEL, 'Delete Me', '08122222222'],
    ] as const) {
      await prisma.customer.upsert({
        where: { id },
        create: { id, businessId: BID, name, phone },
        update: {},
      });
    }

    // DEBT — 500000, dueDate +5d, one 50000 payment + one sent reminder -> partial, schedule present.
    await prisma.debt.upsert({
      where: { id: DEBT },
      create: {
        id: DEBT,
        businessId: BID,
        customerId: CUST,
        amount: 500000,
        note: 'wholesale order',
        dueDate: new Date(now + 5 * DAY),
        createdAt: new Date(now - 3 * DAY),
        lastReminderAt: new Date(now - 1 * DAY),
      },
      update: {},
    });
    await prisma.payment.upsert({
      where: { id: PAY },
      create: {
        id: PAY,
        businessId: BID,
        debtId: DEBT,
        amount: 50000,
        method: 'Cash',
        reference: 'OWM-90001',
        createdAt: new Date(now - 1 * DAY),
      },
      update: {},
    });
    await prisma.reminder.upsert({
      where: { id: REM },
      create: {
        id: REM,
        businessId: BID,
        debtId: DEBT,
        channel: 'sms',
        status: 'sent',
        sentAt: new Date(now - 1 * DAY),
      },
      update: {},
    });
    await prisma.reminder.upsert({
      where: { id: REM_FAILED },
      create: {
        id: REM_FAILED,
        businessId: BID,
        debtId: DEBT,
        channel: 'sms',
        status: 'failed',
        message: 'retry me',
      },
      update: { status: 'failed' },
    });

    // Throwaway debts for mutating endpoints.
    for (const [id, cust] of [
      [DEBT_DEL, CUST],
      [DEBT_PAY, CUST],
      [DEBT_DELC, CUST_DEL],
    ] as const) {
      await prisma.debt.upsert({
        where: { id },
        create: { id, businessId: BID, customerId: cust, amount: 100000, createdAt: new Date(now - 2 * DAY) },
        update: {},
      });
    }

    await prisma.notification.upsert({
      where: { id: NOTIF },
      create: { id: NOTIF, businessId: BID, title: 'Payment received', body: '₦500', kind: 'payment' },
      update: {},
    });

    ownerToken = mint('owner', OWNER_ID);
    staffToken = mint('staff', STAFF_ID);
  });

  afterAll(async () => {
    await app.close();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CROSS-CUTTING GUARD BEHAVIOUR
  // ══════════════════════════════════════════════════════════════════════════
  it('GET /me with NO token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(http).get('/me');
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'UNAUTHENTICATED');
  });

  it('GET /staff as STAFF -> 403 FORBIDDEN (owner-only)', async () => {
    const res = await staff(request(http).get('/staff'));
    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, 'FORBIDDEN');
  });

  it('DELETE /debts/:id as STAFF -> 403 FORBIDDEN (owner-only, S-4)', async () => {
    const res = await staff(request(http).delete(`/debts/${DEBT_DEL}`));
    expect(res.status).toBe(403);
    expectErrorEnvelope(res.body, 'FORBIDDEN');
  });

  it('unknown route -> 404 ErrorEnvelope (global filter)', async () => {
    const res = await owner(request(http).get('/__nope__'));
    expect(res.status).toBe(404);
    expectErrorEnvelope(res.body, 'NOT_FOUND');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // AUTH
  // ══════════════════════════════════════════════════════════════════════════
  it('POST /auth/request-otp -> 202 {} (public, no enumeration)', async () => {
    const res = await request(http).post('/auth/request-otp').send({ phone: '08099998888' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({});
  });

  let issuedRefresh = '';
  let issuedAccess = '';
  it('POST /auth/verify-otp -> 200 { accessToken, refreshToken, user, business }', async () => {
    const phone = '08055554444';
    await prisma.otpCode.create({
      data: {
        id: 'smoke-otp-1',
        phone,
        codeHash: hashOtpCode('123456'),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        attempts: 0,
      },
    });
    const res = await request(http).post('/auth/verify-otp').send({ phone, code: '123456' });
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
    expect(res.body.user).toBeDefined();
    expect(typeof res.body.user.id).toBe('string');
    expect(res.body.business === null || typeof res.body.business === 'object').toBe(true);
    issuedRefresh = res.body.refreshToken;
    issuedAccess = res.body.accessToken;
  });

  it('POST /auth/verify-otp wrong code -> 401 UNAUTHENTICATED', async () => {
    const phone = '08066665555';
    await prisma.otpCode.create({
      data: {
        id: 'smoke-otp-2',
        phone,
        codeHash: hashOtpCode('654321'),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        attempts: 0,
      },
    });
    const res = await request(http).post('/auth/verify-otp').send({ phone, code: '000000' });
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'UNAUTHENTICATED');
  });

  it('POST /auth/refresh -> 200 { accessToken, refreshToken } (rotation)', async () => {
    const res = await request(http).post('/auth/refresh').send({ refreshToken: issuedRefresh });
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
  });

  it('POST /auth/logout -> 204 (bearer)', async () => {
    const res = await request(http)
      .post('/auth/logout')
      .set('Authorization', `Bearer ${issuedAccess}`);
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it('GET /me as owner -> 200 { user, business }', async () => {
    const res = await owner(request(http).get('/me'));
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(OWNER_ID);
    expect(res.body.business.id).toBe(BID);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // BUSINESS
  // ══════════════════════════════════════════════════════════════════════════
  it('GET /business -> 200 Business', async () => {
    const res = await staff(request(http).get('/business'));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(BID);
    expect(typeof res.body.businessName).toBe('string');
    expect(typeof res.body.version).toBe('number');
  });

  it('PUT /business as owner -> 200 Business (staff -> 403)', async () => {
    const forbidden = await staff(request(http).put('/business')).send({ businessName: 'Nope' });
    expect(forbidden.status).toBe(403);

    const res = await owner(request(http).put('/business')).send({
      businessName: 'Smoke Traders Ltd',
      reminderTone: 'friendly',
    });
    expect(res.status).toBe(200);
    expect(res.body.businessName).toBe('Smoke Traders Ltd');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // STAFF
  // ══════════════════════════════════════════════════════════════════════════
  it('GET /staff as owner -> 200 Staff[] (+ seat usage)', async () => {
    const res = await owner(request(http).get('/staff'));
    expect(res.status).toBe(200);
    const rows = Array.isArray(res.body) ? res.body : res.body.data ?? res.body.staff;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    rows.forEach((s: Record<string, unknown>) => {
      expect(typeof s.id).toBe('string');
      expect(['owner', 'staff']).toContain(s.role);
    });
  });

  it('POST /staff as owner -> 201 Staff (role coerced to staff)', async () => {
    const res = await owner(request(http).post('/staff')).send({
      phone: '08077778888',
      name: 'Chidi',
      role: 'staff',
    });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('staff');
    expect(typeof res.body.id).toBe('string');
  });

  it('PATCH /staff/:id as owner -> 200 Staff (deactivate)', async () => {
    const res = await owner(request(http).patch(`/staff/${STAFF_ID}`)).send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // CUSTOMERS
  // ══════════════════════════════════════════════════════════════════════════
  it('GET /customers -> 200 Paginated<CustomerView>', async () => {
    const res = await staff(request(http).get('/customers'));
    expect(res.status).toBe(200);
    expectPaginated(res.body);
    const c = (res.body.data as Array<Record<string, unknown>>).find((x) => x.id === CUST)!;
    expect(c).toBeDefined();
    expect(typeof c.owed).toBe('number');
    expect(typeof c.debtCount).toBe('number');
  });

  it('GET /customers/:id -> 200 CustomerView', async () => {
    const res = await staff(request(http).get(`/customers/${CUST}`));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(CUST);
    expect(typeof res.body.owed).toBe('number');
  });

  it('POST /customers -> 201 Customer (idempotent on id)', async () => {
    const id = 'smoke-cust-new-1';
    const res = await staff(request(http).post('/customers')).send({
      id,
      name: 'New Cust',
      phone: '08133334444',
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(id);
    const again = await staff(request(http).post('/customers')).send({
      id,
      name: 'New Cust',
      phone: '08133334444',
    });
    expect([200, 201]).toContain(again.status);
  });

  it('GET /customers/:id/activity -> 200 ActivityItem[]', async () => {
    const res = await staff(request(http).get(`/customers/${CUST}/activity`));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    res.body.forEach((a: Record<string, unknown>) => {
      expect(['payment', 'debt', 'reminder']).toContain(a.kind);
      expect(typeof a.at).toBe('string');
    });
  });

  it('GET /customers/:id/risk -> 501 (scaffold)', async () => {
    const res = await staff(request(http).get(`/customers/${CUST}/risk`));
    expect(res.status).toBe(501);
    expectErrorEnvelope(res.body);
  });

  it('DELETE /customers/:id as owner -> 200 Customer (soft-archives debts)', async () => {
    const res = await owner(request(http).delete(`/customers/${CUST_DEL}`));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(CUST_DEL);
    const debt = await prisma.debt.findUnique({ where: { id: DEBT_DELC } });
    expect(debt?.deleted).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // DEBTS
  // ══════════════════════════════════════════════════════════════════════════
  it('GET /debts -> 200 Paginated<DebtView>', async () => {
    const res = await staff(request(http).get('/debts'));
    expect(res.status).toBe(200);
    expectPaginated(res.body);
    const d = (res.body.data as Array<Record<string, unknown>>).find((x) => x.id === DEBT)!;
    expect(d).toBeDefined();
    expect(d.paidAmount).toBe(50000);
    expect(d.remaining).toBe(450000);
    expect(typeof d.status).toBe('string');
    expect((d.customer as Record<string, unknown>).id).toBe(CUST);
  });

  it('GET /debts/:id -> 200 DebtView', async () => {
    const res = await staff(request(http).get(`/debts/${DEBT}`));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(DEBT);
    expect(res.body.remaining).toBe(450000);
  });

  it('POST /debts -> 201 DebtView (idempotent)', async () => {
    const id = 'smoke-debt-new-1';
    const res = await staff(request(http).post('/debts')).send({ id, customerId: CUST, amount: 12345 });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(id);
    expect(res.body.remaining).toBe(12345);
  });

  it('PATCH /debts/:id with If-Match -> 200 DebtView', async () => {
    const before = await owner(request(http).get(`/debts/${DEBT}`));
    const res = await owner(request(http).patch(`/debts/${DEBT}`))
      .set('If-Match', `version=${before.body.version}`)
      .send({ note: 'updated by smoke' });
    expect(res.status).toBe(200);
    expect(res.body.note).toBe('updated by smoke');
    expect(res.body.version).toBe(before.body.version + 1);
  });

  it('DELETE /debts/:id as owner -> 200 (soft delete); POST restore -> deleted=false', async () => {
    const del = await owner(request(http).delete(`/debts/${DEBT_DEL}`));
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
    const restored = await staff(request(http).post(`/debts/${DEBT_DEL}/restore`));
    expect([200, 201]).toContain(restored.status);
    expect(restored.body.deleted).toBe(false);
  });

  it('POST /debts/:id/pay-link -> 200/201 { url, fee }', async () => {
    const res = await owner(request(http).post(`/debts/${DEBT}/pay-link`));
    expect([200, 201]).toContain(res.status);
    expect(typeof res.body.url).toBe('string');
    expect(typeof res.body.fee).toBe('number'); // rev 2: combined kobo processing fee
  });

  it('GET /debts/:id/payments -> 200 Payment[]', async () => {
    const res = await staff(request(http).get(`/debts/${DEBT}/payments`));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    res.body.forEach((p: Record<string, unknown>) => {
      expect(typeof p.amount).toBe('number');
      expect(typeof p.reference).toBe('string');
    });
  });

  it('GET /debts/:id/reminders -> 200 Reminder[]', async () => {
    const res = await staff(request(http).get(`/debts/${DEBT}/reminders`));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /debts/:id/reminder-schedule -> 200 4-step schedule', async () => {
    const res = await staff(request(http).get(`/debts/${DEBT}/reminder-schedule`));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(4);
    res.body.forEach((s: Record<string, unknown>) => {
      expect(typeof s.offsetLabel).toBe('string');
      expect(['sent', 'pending']).toContain(s.status);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PAYMENTS
  // ══════════════════════════════════════════════════════════════════════════
  it('POST /debts/:id/payments -> 201 Payment (mints reference)', async () => {
    const id = 'smoke-pay-new-1';
    const res = await staff(request(http).post(`/debts/${DEBT_PAY}/payments`)).send({
      id,
      amount: 40000,
      method: 'Cash',
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(id);
    expect(typeof res.body.reference).toBe('string');
    expect(res.body.amount).toBe(40000);
  });

  it('GET /payments/:id -> 200 { payment, debt, business }', async () => {
    const res = await staff(request(http).get(`/payments/${PAY}`));
    expect(res.status).toBe(200);
    expect(res.body.payment.id).toBe(PAY);
    expect(res.body.debt.id).toBe(DEBT);
    expect(typeof res.body.business.businessName).toBe('string');
  });

  it('POST /debts/:id/undo-payment -> 200 Payment (removed most-recent)', async () => {
    const res = await staff(request(http).post(`/debts/${DEBT_PAY}/undo-payment`));
    expect([200, 201]).toContain(res.status);
    expect(typeof res.body.id).toBe('string');
    expect(typeof res.body.amount).toBe('number');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // REMINDERS
  // ══════════════════════════════════════════════════════════════════════════
  it('GET /reminders -> 200 Paginated<Reminder + {debt,customer}>', async () => {
    const res = await staff(request(http).get('/reminders'));
    expect(res.status).toBe(200);
    expectPaginated(res.body);
  });

  it('POST /reminders (manual, free) -> 201 Reminder', async () => {
    const id = 'smoke-rem-new-1';
    const res = await staff(request(http).post('/reminders')).send({
      id,
      debtId: DEBT,
      channel: 'manual',
      message: 'Please pay',
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(id);
    expect(res.body.channel).toBe('manual');
  });

  it('POST /reminders/:id/retry -> 200 Reminder (failed rows only)', async () => {
    const res = await staff(request(http).post(`/reminders/${REM_FAILED}/retry`));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(REM_FAILED);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // NOTIFICATIONS
  // ══════════════════════════════════════════════════════════════════════════
  it('GET /notifications as owner -> 200 Paginated<Notification>', async () => {
    const res = await owner(request(http).get('/notifications'));
    expect(res.status).toBe(200);
    expectPaginated(res.body);
  });

  it('POST /notifications/mark-all-read -> 204', async () => {
    const res = await owner(request(http).post('/notifications/mark-all-read'));
    expect(res.status).toBe(204);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // NOTIFICATION PREFERENCES
  // ══════════════════════════════════════════════════════════════════════════
  it('GET /notification-preferences as owner -> 200', async () => {
    const res = await owner(request(http).get('/notification-preferences'));
    expect(res.status).toBe(200);
    expect(typeof res.body.payments).toBe('boolean');
    expect(typeof res.body.weekly).toBe('boolean');
  });

  it('PUT /notification-preferences as owner -> 200', async () => {
    const res = await owner(request(http).put('/notification-preferences')).send({
      payments: false,
      overdue: true,
      delivery: true,
      weekly: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.payments).toBe(false);
    expect(res.body.weekly).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // DASHBOARD / ACTIVITY
  // ══════════════════════════════════════════════════════════════════════════
  it('GET /dashboard -> 200 recovery summary', async () => {
    const res = await staff(request(http).get('/dashboard'));
    expect(res.status).toBe(200);
    for (const k of [
      'outstandingTotal',
      'owingCustomerCount',
      'recoveredThisMonth',
      'dueTodayTotal',
      'overdueTotal',
      'overdueCount',
    ]) {
      expect(typeof res.body[k]).toBe('number');
    }
    expect(Array.isArray(res.body.activity)).toBe(true);
    expect(typeof res.body.hasUnread).toBe('boolean');
  });

  it('GET /activity -> 200 Paginated<ActivityItem>', async () => {
    const res = await staff(request(http).get('/activity'));
    expect(res.status).toBe(200);
    expectPaginated(res.body);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PAYOUT ACCOUNT / BANKS
  // ══════════════════════════════════════════════════════════════════════════
  it('GET /banks as owner -> 200 Bank[]', async () => {
    const res = await owner(request(http).get('/banks'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    res.body.forEach((b: Record<string, unknown>) => {
      expect(typeof b.code).toBe('string');
      expect(typeof b.name).toBe('string');
    });
  });

  it('POST /payout-account/resolve as owner -> 200 { accountName }', async () => {
    const res = await owner(request(http).post('/payout-account/resolve')).send({
      bankCode: '044',
      accountNumber: '0123456789',
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.accountName).toBe('string');
  });

  it('GET /payout-account as owner -> 200 PayoutAccount|null', async () => {
    const res = await owner(request(http).get('/payout-account'));
    expect(res.status).toBe(200);
    expect(res.body === null || typeof res.body === 'object').toBe(true);
  });

  it('PUT /payout-account as owner -> 200 PayoutAccount', async () => {
    const res = await owner(request(http).put('/payout-account')).send({
      bankCode: '044',
      accountNumber: '0123456789',
      accountName: 'SMOKE TRADERS',
    });
    expect(res.status).toBe(200);
    expect(res.body.accountNumber).toBe('0123456789');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PLANS / SUBSCRIPTION / BILLING / USAGE / BVUM
  // ══════════════════════════════════════════════════════════════════════════
  it('GET /plans -> 200 Plan[] (5 canonical)', async () => {
    const res = await staff(request(http).get('/plans'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.map((p: Record<string, unknown>) => p.id).sort()).toEqual([
      'business',
      'enterprise',
      'market',
      'starter',
      'wholesale',
    ]);
    res.body.forEach((p: Record<string, unknown>) => {
      expect(typeof p.pricePerMonth).toBe('number');
      // rev 2 limits: { creditsPerMonth, staffSeats, bvumCeiling } (no sends/aiCredits);
      // bvumCeiling is a concrete number for every plan (never null).
      const limits = p.limits as Record<string, unknown>;
      expect(typeof limits.creditsPerMonth).toBe('number');
      expect(typeof limits.staffSeats).toBe('number');
      expect(typeof limits.bvumCeiling).toBe('number');
    });
    const enterprise = (res.body as Array<Record<string, unknown>>).find((p) => p.id === 'enterprise')!;
    expect((enterprise.limits as Record<string, unknown>).bvumCeiling).toBe(4_000_000_000);
  });

  it('GET /subscription as owner -> 200 entitlement', async () => {
    const res = await owner(request(http).get('/subscription'));
    expect(res.status).toBe(200);
    expect(typeof res.body.planId).toBe('string');
    expect(typeof res.body.entitlementState).toBe('string');
    expect(typeof res.body.activePlanId).toBe('string');
  });

  it('POST /billing/verify-receipt (credits bundle) as owner -> 2xx { ledger }', async () => {
    const res = await owner(request(http).post('/billing/verify-receipt')).send({
      platform: 'android',
      productId: 'oweme_credits_250',
      receipt: 'smoke-receipt-1',
    });
    expect([200, 201]).toContain(res.status);
    expect(res.body.ledger || res.body.entitlement).toBeDefined();
  });

  it('GET /billing/history as owner -> 200 Paginated<BillingTransaction>', async () => {
    const res = await owner(request(http).get('/billing/history'));
    expect(res.status).toBe(200);
    expectPaginated(res.body);
  });

  it('GET /usage as owner -> 200 { credits: { used, limit, balance, monthlyGrant, periodStart } }', async () => {
    const res = await owner(request(http).get('/usage'));
    expect(res.status).toBe(200);
    expect(typeof res.body.credits).toBe('object');
    expect(typeof res.body.credits.used).toBe('number');
    expect(typeof res.body.credits.limit).toBe('number');
    expect(typeof res.body.credits.balance).toBe('number');
    expect(typeof res.body.credits.monthlyGrant).toBe('number');
    expect(typeof res.body.credits.periodStart).toBe('string');
  });

  it('GET /bvum as owner -> 200 { value, ceiling, recommendedPlan, windowDays }', async () => {
    const res = await owner(request(http).get('/bvum'));
    expect(res.status).toBe(200);
    expect(typeof res.body.value).toBe('number');
    // rev 2: ceiling is a concrete number for every plan (business tier -> ₦6M), never null.
    expect(typeof res.body.ceiling).toBe('number');
    expect(res.body.windowDays).toBe(30);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // VOICE / INSIGHTS (AI)
  // ══════════════════════════════════════════════════════════════════════════
  it('POST /voice/parse -> 200 structured debt (debits 1 credit)', async () => {
    const res = await staff(request(http).post('/voice/parse')).send({
      transcript: 'Amaka owes me 2500 naira for engine oil',
    });
    expect(res.status).toBe(200);
    expect('customerName' in res.body).toBe(true);
    expect(typeof res.body.amount).toBe('number');
  });

  it('GET /insights/dashboard as owner -> 501 (scaffold)', async () => {
    const res = await owner(request(http).get('/insights/dashboard'));
    expect(res.status).toBe(501);
    expectErrorEnvelope(res.body);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SYNC
  // ══════════════════════════════════════════════════════════════════════════
  it('GET /sync -> 200 { changes, tombstones, cursor }', async () => {
    const res = await staff(request(http).get('/sync'));
    expect(res.status).toBe(200);
    for (const k of ['customers', 'debts', 'payments', 'reminders']) {
      expect(Array.isArray(res.body.changes[k])).toBe(true);
      expect(Array.isArray(res.body.tombstones[k])).toBe(true);
    }
    expect(typeof res.body.cursor).toBe('string');
  });

  it('GET /sync/status -> 200 { lastSyncedAt, pendingCount }', async () => {
    const res = await staff(request(http).get('/sync/status'));
    expect(res.status).toBe(200);
    expect('lastSyncedAt' in res.body).toBe(true);
    expect(typeof res.body.pendingCount).toBe('number');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // WEBHOOKS (public, provider-signature)
  // ══════════════════════════════════════════════════════════════════════════
  it('POST /webhooks/paystack valid signature (NO JWT) -> 200', async () => {
    const reference = 'PAYL_smoke_ref_1';
    const payload = JSON.stringify({
      event: 'charge.success',
      data: { reference, amount: 100000, metadata: { debtId: DEBT_PAY, businessId: BID } },
    });
    const res = await request(http)
      .post('/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', sign(payload))
      .send(payload);
    expect(res.status).toBe(200);
  });

  it('POST /webhooks/paystack INVALID signature -> 401 (rejected)', async () => {
    const payload = JSON.stringify({ event: 'charge.success', data: { reference: 'x', amount: 1 } });
    const res = await request(http)
      .post('/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', 'deadbeef-not-a-real-hmac')
      .send(payload);
    expect(res.status).toBe(401);
    expectErrorEnvelope(res.body, 'UNAUTHENTICATED');
  });

  it('POST /webhooks/iap valid (NO JWT) -> 200 credits ledger', async () => {
    const res = await request(http)
      .post('/webhooks/iap')
      .set('Content-Type', 'application/json')
      .send({
        platform: 'android',
        productId: 'oweme_credits_250',
        receipt: 'smoke-iap-1',
        businessId: BID,
      });
    expect(res.status).toBe(200);
  });
});
