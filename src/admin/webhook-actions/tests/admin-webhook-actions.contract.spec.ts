import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { createHmac, timingSafeEqual } from 'crypto';
import request from 'supertest';

import { PrismaModule } from '../../../prisma/prisma.module';
import { PrismaService } from '../../../prisma/prisma.service';
import { CommonModule } from '../../../common/common.module';
import { HttpExceptionFilter } from '../../../common/filters/http-exception.filter';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import {
  OTP_SENDER,
  OtpSender,
  PAYSTACK_GATEWAY,
  PaystackGateway,
  RECEIPT_VERIFIER,
  StubPaystackGateway,
  StubReceiptVerifier,
  uuidv7,
} from '../../../common';
import { AuthModule } from '../../../auth/auth.module';
import { AdminModule } from '../../admin.module';
import { hashPassword } from '../../common';
import { AdminWebhookActionsModule } from '../admin-webhook-actions.module';

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

const PAYSTACK_SECRET = 'test-paystack-webhook-secret';
const sign = (raw: string): string => createHmac('sha512', PAYSTACK_SECRET).update(raw).digest('hex');

/**
 * Real HMAC gateway (the default stub accepts ANY signature, which cannot prove that a
 * replay still crosses the provider trust boundary). Only verifySignature matters here.
 */
class HmacPaystackGateway extends StubPaystackGateway implements PaystackGateway {
  verifySignature(rawBody: Buffer | string, signature: string): boolean {
    const expected = createHmac('sha512', PAYSTACK_SECRET)
      .update(typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody)
      .digest('hex');
    if (!signature || signature.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }
}

/**
 * AdminWebhookActions (contract). Same boot as app.module (global user guards,
 * ValidationPipe, HttpExceptionFilter) plus AdminModule (admin login), AuthModule (a real
 * user session for cross-rejection) and this resource's module, which the integrator
 * registers on AdminModule separately.
 *
 * Covers: the auth/role gates, the EMPTY webhook_event_log (unknown id -> 404), every
 * refusal path, the Paystack and IAP happy paths asserting BOTH the live state change and
 * the audit row, and re-run safety (a second replay of the same work applies nothing twice).
 */
describe('AdminWebhookActions (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sender = new SpyOtpSender();

  const ROOT_EMAIL = 'root-webhook-actions@oweme.app';
  const ROOT_PASSWORD = 'RootPass!2026';
  const SUPPORT_EMAIL = 'support-webhook-actions@oweme.app';
  const SUPPORT_PASSWORD = 'SupportPass!1';
  const USER_PHONE = '2348039990088';
  let rootAccess: string;
  let supportAccess: string;
  let userAccess: string;
  let rootId: string;
  let supportId: string;

  const BUSINESS = uuidv7(); // Mama Nkechi Provisions
  const CUSTOMER = uuidv7(); // Chidinma Eze
  const DEBT = uuidv7();
  const DEBT_AMOUNT = 500_000; // N5,000

  const IAP_RECEIPT = 'iap-receipt-market-001';
  // StubReceiptVerifier derives the store transaction id from the receipt; the
  // BillingTransaction row under that id is the server-side tenant binding.
  const IAP_TXN = `stub-txn-${IAP_RECEIPT.slice(0, 16)}`;

  const login = async (email: string, password: string) =>
    request(app.getHttpServer()).post('/admin/auth/login').send({ email, password });

  const replay = async (id: string, token = rootAccess) =>
    request(app.getHttpServer())
      .post(`/admin/webhooks/events/${id}/replay`)
      .set('Authorization', `Bearer ${token}`);

  /** Seed one webhook_event_log row exactly as the capture-time instrumentation would. */
  const seedEvent = async (
    source: string,
    eventType: string,
    reference: string | null,
    outcome: string,
    detail: object | null,
  ): Promise<string> => {
    const id = uuidv7();
    await prisma.webhookEventLog.create({
      data: { id, source, eventType, reference, outcome, detail: detail ?? undefined },
    });
    return id;
  };

  /** A verified charge.success delivery, retained for replay (payload + rawBody + signature). */
  const paystackDetail = (reference: string, amount: number, debtId: string): object => {
    const payload = {
      event: 'charge.success',
      data: { reference, amount, metadata: { debtId, businessId: BUSINESS, customerId: CUSTOMER } },
    };
    const rawBody = JSON.stringify(payload);
    return { payload, rawBody, signature: sign(rawBody), businessId: BUSINESS };
  };

  const auditRows = async (targetId: string) =>
    prisma.adminAuditLog.findMany({
      where: { actionType: 'replay-webhook', targetId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, AdminModule, AdminWebhookActionsModule, AuthModule],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideProvider(OTP_SENDER)
      .useValue(sender)
      .overrideProvider(PAYSTACK_GATEWAY)
      .useValue(new HmacPaystackGateway())
      // The repo .env carries IAP credentials, so the real verifier would be selected;
      // the deterministic stub keeps the replay assertions provider-independent.
      .overrideProvider(RECEIPT_VERIFIER)
      .useClass(StubReceiptVerifier)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    prisma = app.get(PrismaService);
    await app.init();

    await prisma.notification.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.debt.deleteMany({});
    await prisma.customer.deleteMany({});
    await prisma.billingTransaction.deleteMany({});
    await prisma.subscription.deleteMany({});
    await prisma.webhookEventLog.deleteMany({});
    await prisma.adminAuditLog.deleteMany({});
    await prisma.adminRefreshToken.deleteMany({});
    await prisma.adminUser.deleteMany({});

    for (const [email, name, role, password] of [
      [ROOT_EMAIL, 'Webhook Root', 'superadmin', ROOT_PASSWORD],
      [SUPPORT_EMAIL, 'Webhook Support', 'support', SUPPORT_PASSWORD],
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
    rootId = (await prisma.adminUser.findUnique({ where: { email: ROOT_EMAIL } }))!.id;
    supportId = (await prisma.adminUser.findUnique({ where: { email: SUPPORT_EMAIL } }))!.id;

    const otpReq = await request(app.getHttpServer())
      .post('/auth/request-otp')
      .send({ phone: USER_PHONE });
    expect(otpReq.status).toBe(202);
    const userSession = await request(app.getHttpServer())
      .post('/auth/verify-otp')
      .send({ phone: USER_PHONE, code: sender.codes.get(USER_PHONE)! });
    expect(userSession.status).toBe(200);
    userAccess = userSession.body.accessToken as string;

    await prisma.business.upsert({
      where: { id: BUSINESS },
      update: { plan: 'starter' },
      create: {
        id: BUSINESS,
        businessName: 'Mama Nkechi Provisions',
        ownerName: 'Nkechi',
        phone: '2348000000000',
        category: 'Retail',
        currency: 'NGN (₦)',
        reminderTone: 'friendly',
      },
    });
    await prisma.customer.create({
      data: { id: CUSTOMER, businessId: BUSINESS, name: 'Chidinma Eze', phone: '08030000000' },
    });
    await prisma.debt.create({
      data: {
        id: DEBT,
        businessId: BUSINESS,
        customerId: CUSTOMER,
        amount: DEBT_AMOUNT,
        nextReminderAt: new Date('2026-08-01T09:00:00Z'),
      },
    });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.debt.deleteMany({});
    await prisma.customer.deleteMany({});
    await prisma.billingTransaction.deleteMany({});
    await prisma.subscription.deleteMany({});
    await prisma.webhookEventLog.deleteMany({});
    await prisma.business.deleteMany({ where: { id: BUSINESS } });
    await app.close();
  });

  describe('auth and role gates', () => {
    it('no token -> 401 UNAUTHENTICATED', async () => {
      const res = await request(app.getHttpServer()).post(
        `/admin/webhooks/events/${uuidv7()}/replay`,
      );
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('a real USER token is rejected on the admin surface -> 401', async () => {
      const res = await replay(uuidv7(), userAccess);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('support is ALLOWED here (conventions role matrix: support may replay a webhook)', async () => {
      // The gate passes; the id is unknown, so it fails on the resource, never on the role.
      const res = await replay(uuidv7(), supportAccess);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('empty webhook_event_log (instrumentation has not landed)', () => {
    it('the table is empty and any id -> 404 NOT_FOUND, with nothing written', async () => {
      expect(await prisma.webhookEventLog.count()).toBe(0);

      const res = await replay(uuidv7());
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');

      expect(await prisma.webhookEventLog.count()).toBe(0);
      expect(await prisma.adminAuditLog.count({ where: { actionType: 'replay-webhook' } })).toBe(0);
    });
  });

  describe('refusals (nothing is written)', () => {
    it('outcome ok and outcome ignored are NOT replayable -> 422 VALIDATION_ERROR', async () => {
      const ok = await seedEvent('paystack', 'charge.success', 'PAYL_OK', 'ok', null);
      const ignored = await seedEvent('paystack', 'transfer.failed', 'PAYL_IGN', 'ignored', null);
      const before = await prisma.webhookEventLog.count();

      for (const id of [ok, ignored]) {
        const res = await replay(id);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      expect(await prisma.webhookEventLog.count()).toBe(before);
      expect(await prisma.adminAuditLog.count({ where: { actionType: 'replay-webhook' } })).toBe(0);
    });

    it('an error row retaining no payload -> 422, and it stays in error', async () => {
      const id = await seedEvent('paystack', 'charge.success', 'PAYL_NODETAIL', 'error', null);
      const before = await prisma.webhookEventLog.count();

      const res = await replay(id);
      expect(res.status).toBe(422);
      expect(res.body.error.message).toContain('retains no payload');

      const row = await prisma.webhookEventLog.findUnique({ where: { id } });
      expect(row!.outcome).toBe('error');
      expect(await prisma.webhookEventLog.count()).toBe(before);
    });

    it('a Paystack error row retaining no signature -> 422 (the HMAC is never bypassed)', async () => {
      const payload = {
        event: 'charge.success',
        data: { reference: 'PAYL_NOSIG', amount: 100_000, metadata: { debtId: DEBT } },
      };
      const id = await seedEvent('paystack', 'charge.success', 'PAYL_NOSIG', 'error', { payload });

      const res = await replay(id);
      expect(res.status).toBe(422);
      expect(res.body.error.message).toContain('no provider signature');
      expect(await prisma.payment.count()).toBe(0);
    });

    it('the capture shape { message, body } is read, but a Paystack row without its signature still refuses', async () => {
      // Pins the integration expectation against the capture-time instrumentation: the
      // payload alias is understood, the missing signature is what blocks the replay.
      const body = {
        event: 'charge.success',
        data: { reference: 'PAYL_CAPTURE', amount: 100_000, metadata: { debtId: DEBT } },
      };
      const id = await seedEvent('paystack', 'charge.success', 'PAYL_CAPTURE', 'error', {
        message: 'Error: debt not found',
        body,
      });

      const res = await replay(id);
      expect(res.status).toBe(422);
      expect(res.body.error.message).toContain('no provider signature');

      // With the signature retained alongside it, the very same shape replays.
      const signed = await seedEvent('paystack', 'charge.success', 'PAYL_CAPTURE', 'error', {
        message: 'Error: debt not found',
        body,
        rawBody: JSON.stringify(body),
        signature: sign(JSON.stringify(body)),
      });
      const ok = await replay(signed);
      expect(ok.status).toBe(201);
      expect(ok.body.outcome).toBe('ok');
      expect(await prisma.payment.count({ where: { reference: 'PAYL_CAPTURE' } })).toBe(1);
      await prisma.payment.deleteMany({ where: { reference: 'PAYL_CAPTURE' } });
      await prisma.notification.deleteMany({});
    });

    it('a source with no processing path -> 422', async () => {
      const id = await seedEvent('flutterwave', 'charge.completed', 'FLW_1', 'error', {
        payload: { event: 'charge.completed' },
      });
      const res = await replay(id);
      expect(res.status).toBe(422);
      expect(res.body.error.message).toContain('no processing path');
    });
  });

  describe('POST /admin/webhooks/events/:id/replay - Paystack', () => {
    const REFERENCE = 'PAYL_REPLAY_0001';
    let errorId: string;

    beforeAll(async () => {
      errorId = await seedEvent(
        'paystack',
        'charge.success',
        REFERENCE,
        'error',
        paystackDetail(REFERENCE, DEBT_AMOUNT, DEBT),
      );
    });

    it('re-delivers the retained charge: Payment recorded, debt settled, log + audit written', async () => {
      const res = await replay(errorId);
      expect(res.status).toBe(201);

      // The response is the APPENDED outcome row (registry response shape).
      expect(Object.keys(res.body).sort()).toEqual([
        'at',
        'detail',
        'eventType',
        'id',
        'outcome',
        'reference',
        'source',
      ]);
      expect(res.body.id).not.toBe(errorId);
      expect(res.body.source).toBe('paystack');
      expect(res.body.eventType).toBe('charge.success');
      expect(res.body.reference).toBe(REFERENCE);
      expect(res.body.outcome).toBe('ok');
      expect(res.body.detail).toEqual({
        replayOfId: errorId,
        replayedByAdminId: rootId,
        processed: true,
        businessId: BUSINESS,
      });

      // STATE CHANGE: the live webhook path ran, so the money is now visible.
      const payments = await prisma.payment.findMany({ where: { reference: REFERENCE } });
      expect(payments).toHaveLength(1);
      expect(payments[0].amount).toBe(DEBT_AMOUNT);
      expect(payments[0].method).toBe('Paystack link');
      expect(payments[0].businessId).toBe(BUSINESS);
      const debt = await prisma.debt.findUnique({ where: { id: DEBT } });
      expect(debt!.nextReminderAt).toBeNull(); // fully paid -> reminder schedule stops
      const notes = await prisma.notification.findMany({ where: { businessId: BUSINESS } });
      expect(notes).toHaveLength(1);
      expect(notes[0].title).toBe('Payment received');

      // The source row is no longer an error: the failure was resolved by this replay.
      const source = await prisma.webhookEventLog.findUnique({ where: { id: errorId } });
      expect(source!.outcome).toBe('ok');
      expect(source!.detail).not.toBeNull(); // the original payload is preserved verbatim

      // AUDIT ROW with a truthful before/after.
      const audits = await auditRows(errorId);
      expect(audits).toHaveLength(1);
      expect(audits[0].adminUserId).toBe(rootId);
      expect(audits[0].adminRoleSnapshot).toBe('superadmin');
      expect(audits[0].actionType).toBe('replay-webhook');
      expect(audits[0].action).toContain(REFERENCE);
      expect(audits[0].targetType).toBe('WebhookEventLog');
      expect(audits[0].targetBusinessId).toBe(BUSINESS);
      expect(audits[0].before).toEqual({ outcome: 'error' });
      expect(audits[0].after).toEqual({
        outcome: 'ok',
        processed: true,
        replayEventId: res.body.id,
      });
    });

    it('re-running the SAME replay is refused (the row is resolved) and applies nothing twice', async () => {
      const res = await replay(errorId);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(await prisma.payment.count({ where: { reference: REFERENCE } })).toBe(1);
      expect(await auditRows(errorId)).toHaveLength(1);
    });

    it('a DUPLICATE error row for work already done replays successfully as a no-op', async () => {
      const duplicate = await seedEvent(
        'paystack',
        'charge.success',
        REFERENCE,
        'error',
        paystackDetail(REFERENCE, DEBT_AMOUNT, DEBT),
      );
      const res = await replay(duplicate, supportAccess);
      expect(res.status).toBe(201);
      expect(res.body.outcome).toBe('ignored'); // idempotent on the reference: nothing re-applied
      expect(res.body.detail.processed).toBe(false);

      // No second Payment, no second Notification, no double settlement.
      expect(await prisma.payment.count({ where: { reference: REFERENCE } })).toBe(1);
      expect(await prisma.notification.count({ where: { businessId: BUSINESS } })).toBe(1);

      const source = await prisma.webhookEventLog.findUnique({ where: { id: duplicate } });
      expect(source!.outcome).toBe('ignored');

      const audits = await auditRows(duplicate);
      expect(audits).toHaveLength(1);
      expect(audits[0].adminUserId).toBe(supportId);
      expect(audits[0].adminRoleSnapshot).toBe('support');
      expect(audits[0].after).toMatchObject({ outcome: 'ignored', processed: false });
      expect(audits[0].note).toContain('Already reconciled');
    });

    it('a retained signature that no longer verifies -> 422, error row appended, still replayable', async () => {
      const reference = 'PAYL_BADSIG';
      const payload = {
        event: 'charge.success',
        data: { reference, amount: 100_000, metadata: { debtId: DEBT } },
      };
      const id = await seedEvent('paystack', 'charge.success', reference, 'error', {
        payload,
        rawBody: JSON.stringify(payload),
        signature: 'deadbeef-not-a-real-hmac',
      });

      const res = await replay(id);
      expect(res.status).toBe(422);
      expect(res.body.error.message).toContain('Replay failed');
      expect(await prisma.payment.count({ where: { reference } })).toBe(0);

      // Source row stays in error; a fresh error row records the failed attempt and
      // carries the payload forward so it can be replayed again once the cause is fixed.
      const source = await prisma.webhookEventLog.findUnique({ where: { id } });
      expect(source!.outcome).toBe('error');
      const appended = await prisma.webhookEventLog.findFirst({
        where: { reference, id: { not: id } },
      });
      expect(appended!.outcome).toBe('error');
      const detail = appended!.detail as Record<string, unknown>;
      expect(detail.replayOfId).toBe(id);
      expect(typeof detail.error).toBe('string');
      expect(detail.payload).toEqual(payload);

      const audits = await auditRows(id);
      expect(audits).toHaveLength(1);
      expect(audits[0].after).toMatchObject({ outcome: 'error', processed: false });
    });
  });

  describe('POST /admin/webhooks/events/:id/replay - IAP', () => {
    it('re-delivers a bound renewal: plan + entitlement applied, log + audit written', async () => {
      await prisma.billingTransaction.create({
        data: {
          id: IAP_TXN,
          businessId: BUSINESS,
          kind: 'subscription',
          productId: 'oweme_market_monthly',
          label: 'Market monthly',
          amount: 0,
        },
      });
      const id = await seedEvent('iap', 'DID_RENEW', IAP_TXN, 'error', {
        payload: {
          platform: 'ios',
          productId: 'oweme_market_monthly',
          receipt: IAP_RECEIPT,
          notificationType: 'DID_RENEW',
        },
        businessId: BUSINESS,
      });

      const res = await replay(id, supportAccess);
      expect(res.status).toBe(201);
      expect(res.body.source).toBe('iap');
      expect(res.body.outcome).toBe('ok');

      const business = await prisma.business.findUnique({ where: { id: BUSINESS } });
      expect(business!.plan).toBe('market');
      const subscription = await prisma.subscription.findUnique({
        where: { businessId: BUSINESS },
      });
      expect(subscription!.entitlementState).toBe('active');
      expect(subscription!.activePlanId).toBe('market');

      const source = await prisma.webhookEventLog.findUnique({ where: { id } });
      expect(source!.outcome).toBe('ok');

      const audits = await auditRows(id);
      expect(audits).toHaveLength(1);
      expect(audits[0].adminRoleSnapshot).toBe('support');
      expect(audits[0].targetBusinessId).toBe(BUSINESS);
      expect(audits[0].before).toEqual({ outcome: 'error' });
      expect(audits[0].after).toMatchObject({ outcome: 'ok', processed: true });
    });

    it('an UNBOUND notification replays to an honest no-op (ignored), never a guessed tenant', async () => {
      const id = await seedEvent('iap', 'DID_RENEW', 'unbound-txn', 'error', {
        payload: {
          platform: 'ios',
          productId: 'oweme_market_monthly',
          receipt: 'iap-receipt-unbound-999',
          // A tenant claim in the body must never be trusted; there is no binding row.
          businessId: BUSINESS,
          notificationType: 'DID_RENEW',
        },
      });

      const res = await replay(id);
      expect(res.status).toBe(201);
      expect(res.body.outcome).toBe('ignored');
      expect(res.body.detail.processed).toBe(false);

      const source = await prisma.webhookEventLog.findUnique({ where: { id } });
      expect(source!.outcome).toBe('ignored');
      expect(await auditRows(id)).toHaveLength(1);
    });
  });
});
