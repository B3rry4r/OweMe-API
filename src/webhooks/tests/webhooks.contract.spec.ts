import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { createHmac, timingSafeEqual } from 'crypto';
import request from 'supertest';

import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { CommonModule } from '../../common/common.module';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  PAYSTACK_GATEWAY,
  PaystackGateway,
  PaystackBank,
  ResolveAccountResult,
  CreateSubaccountInput,
  CreateSubaccountResult,
  PaymentRequestInput,
  PaymentRequestResult,
  RECEIPT_VERIFIER,
  ReceiptVerifier,
  VerifyReceiptInput,
  VerifyReceiptResult,
} from '../../common';
import { WebhooksModule } from '../webhooks.module';

/**
 * Webhooks (contract). Boots a real Nest app with the SAME global guards (JwtAuthGuard +
 * RolesGuard), HttpExceptionFilter and ValidationPipe as app.module, and with rawBody enabled
 * (Paystack signs the raw request body).
 *
 * PAYSTACK_GATEWAY is overridden with a verifier that does a REAL HMAC-SHA512 check against a
 * known webhook secret (the default stub accepts any signature, which cannot prove rejection).
 * RECEIPT_VERIFIER is overridden with a deterministic stub whose transaction id is keyed on the
 * receipt string, so the server-side tenant binding (BillingTransaction primary key) and
 * idempotency are both provable.
 *
 * Hardened semantics under test:
 *   - Paystack: every verified charge is recorded in full; overpayment settles the debt and
 *     flags the excess via a Notification; a charge on an archived debt is recorded WITHOUT
 *     unarchiving and flagged via a Notification; the normal path writes a payment-received
 *     Notification (the app feed).
 *   - IAP: tenant is bound ONLY via the BillingTransaction persisted at verify-receipt time;
 *     body.businessId is never trusted; unbound events are acked and ignored with no state change.
 */

const PAYSTACK_SECRET = 'test-paystack-webhook-secret';

/** HMAC-SHA512 over the raw body: the real Paystack signature scheme. */
class HmacPaystackGateway implements PaystackGateway {
  async listBanks(): Promise<PaystackBank[]> {
    return [];
  }
  async resolveAccount(_bankCode: string, accountNumber: string): Promise<ResolveAccountResult> {
    return { accountName: `TEST ${accountNumber}` };
  }
  async createSubaccount(input: CreateSubaccountInput): Promise<CreateSubaccountResult> {
    return { subaccountCode: `ACCT_${input.accountNumber}` };
  }
  async createPaymentRequest(input: PaymentRequestInput): Promise<PaymentRequestResult> {
    return { url: `https://paystack.test/${input.reference}`, reference: input.reference };
  }
  verifySignature(rawBody: Buffer | string, signature: string): boolean {
    const expected = createHmac('sha512', PAYSTACK_SECRET)
      .update(typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody)
      .digest('hex');
    if (!signature || signature.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }
}

/** IAP verifier: always valid; transaction id keyed on the receipt (binding + idempotency probe). */
class StubReceiptVerifier implements ReceiptVerifier {
  async verify(input: VerifyReceiptInput): Promise<VerifyReceiptResult> {
    return { valid: true, transactionId: `txn-${input.receipt}`, productId: input.productId };
  }
}

const sign = (raw: string): string => createHmac('sha512', PAYSTACK_SECRET).update(raw).digest('hex');

describe('Webhooks (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  // Distinctive tenant ids so this suite never collides with other waves' seeded rows.
  const BIZ = '01912ddd-eeee-7fff-8aaa-webhooks000biz';
  const CUSTOMER = '01912ddd-eeee-7fff-8aaa-webhooks00cust';
  const DEBT = '01912ddd-eeee-7fff-8aaa-webhooks00debt';
  const DEBT_OVER = '01912ddd-eeee-7fff-8aaa-webhooks0over';
  const DEBT_ARCH = '01912ddd-eeee-7fff-8aaa-webhooks0arch';
  const BIZ_IAP = '01912ddd-eeee-7fff-8aaa-webhooks00iapb';
  const BIZ_SPOOF = '01912ddd-eeee-7fff-8aaa-webhooksspoof';

  const DEBT_AMOUNT = 500_000; // kobo
  const DEBT_OVER_AMOUNT = 200_000; // kobo
  const DEBT_ARCH_AMOUNT = 300_000; // kobo

  // Bindings persisted "at verify-receipt time" (BillingTransaction primary key = store txn id).
  const BOUND_SUB_RECEIPT = 'iap-sub-1'; // stub txn id: txn-iap-sub-1
  const BOUND_BUNDLE_RECEIPT = 'iap-bundle-1'; // stub txn id: txn-iap-bundle-1
  const PLAN_PRODUCT = 'oweme_business_monthly'; // seeded Plan catalog product

  const postPaystack = (payload: string) =>
    request(app.getHttpServer())
      .post('/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', sign(payload))
      .send(payload); // NOTE: no Authorization header -> proves the route is @Public

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, WebhooksModule],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideProvider(PAYSTACK_GATEWAY)
      .useClass(HmacPaystackGateway)
      .overrideProvider(RECEIPT_VERIFIER)
      .useClass(StubReceiptVerifier)
      .compile();

    // rawBody so the Paystack signature is verified over the exact received bytes.
    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    prisma = app.get(PrismaService);
    await app.init();

    for (const [id, businessName, ownerName, phone] of [
      [BIZ, 'Webhook Co', 'Ada Owner', '08010000000'],
      [BIZ_IAP, 'IAP Co', 'Bola Owner', '08020000000'],
      [BIZ_SPOOF, 'Spoof Target Co', 'Chika Owner', '08040000000'],
    ] as const) {
      await prisma.business.upsert({
        where: { id },
        create: {
          id,
          businessName,
          ownerName,
          phone,
          category: 'Retail',
          currency: 'NGN (₦)',
          reminderTone: 'gentle',
        },
        update: {},
      });
    }
    await prisma.customer.upsert({
      where: { id: CUSTOMER },
      create: { id: CUSTOMER, businessId: BIZ, name: 'Debtor Dan', phone: '08030000000' },
      update: {},
    });
    await prisma.debt.upsert({
      where: { id: DEBT },
      create: {
        id: DEBT,
        businessId: BIZ,
        customerId: CUSTOMER,
        amount: DEBT_AMOUNT,
        nextReminderAt: new Date(),
      },
      update: {},
    });
    await prisma.debt.upsert({
      where: { id: DEBT_OVER },
      create: {
        id: DEBT_OVER,
        businessId: BIZ,
        customerId: CUSTOMER,
        amount: DEBT_OVER_AMOUNT,
        nextReminderAt: new Date(),
      },
      update: {},
    });
    await prisma.debt.upsert({
      where: { id: DEBT_ARCH },
      create: {
        id: DEBT_ARCH,
        businessId: BIZ,
        customerId: CUSTOMER,
        amount: DEBT_ARCH_AMOUNT,
        deleted: true, // archived
      },
      update: {},
    });

    // Server-side IAP tenant bindings, as persisted by POST /billing/verify-receipt.
    await prisma.billingTransaction.upsert({
      where: { id: `txn-${BOUND_SUB_RECEIPT}` },
      create: {
        id: `txn-${BOUND_SUB_RECEIPT}`,
        businessId: BIZ_IAP,
        kind: 'subscription',
        productId: PLAN_PRODUCT,
        label: 'Business',
        amount: 1_000_000,
      },
      update: {},
    });
    await prisma.billingTransaction.upsert({
      where: { id: `txn-${BOUND_BUNDLE_RECEIPT}` },
      create: {
        id: `txn-${BOUND_BUNDLE_RECEIPT}`,
        businessId: BIZ_IAP,
        kind: 'credits-bundle',
        productId: 'oweme_credits_600',
        label: 'oweme_credits_600',
        amount: 0,
      },
      update: {},
    });
  });

  afterAll(async () => {
    await app.close();
  });

  // --- POST /webhooks/paystack ----------------------------------------------

  it('valid signature + charge.success (no JWT) -> 200, records the Payment, settles the debt, writes a payment-received Notification', async () => {
    const reference = 'PAYL_webhook_ref_1';
    const payload = JSON.stringify({
      event: 'charge.success',
      data: { reference, amount: DEBT_AMOUNT, metadata: { debtId: DEBT, businessId: BIZ } },
    });

    const res = await postPaystack(payload);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, processed: true });

    const payments = await prisma.payment.findMany({ where: { reference } });
    expect(payments.length).toBe(1);
    expect(payments[0].debtId).toBe(DEBT);
    expect(payments[0].amount).toBe(DEBT_AMOUNT);
    expect(payments[0].method).toBe('Paystack link');

    // Balance reached 0 -> reminder schedule stopped.
    const debt = await prisma.debt.findUnique({ where: { id: DEBT } });
    expect(debt?.nextReminderAt).toBeNull();

    // The app feed gets a payment-received row (normal path).
    const feed = await prisma.notification.findMany({ where: { businessId: BIZ } });
    expect(feed.length).toBe(1);
    expect(feed[0].kind).toBe('payment');
    expect(feed[0].title).toBe('Payment received');
    expect(feed[0].body).toContain('Debtor Dan');
    expect(feed[0].body).toContain('₦5,000');
    expect(feed[0].read).toBe(false);

    // Instrumentation: one webhook_event_log row for the verified delivery.
    const logs = await prisma.webhookEventLog.findMany({ where: { reference } });
    expect(logs.length).toBe(1);
    expect(logs[0].source).toBe('paystack');
    expect(logs[0].eventType).toBe('charge.success');
    expect(logs[0].outcome).toBe('ok');
  });

  it('re-post the SAME reference -> idempotent (no duplicate Payment, no duplicate Notification)', async () => {
    const reference = 'PAYL_webhook_ref_1';
    const payload = JSON.stringify({
      event: 'charge.success',
      data: { reference, amount: DEBT_AMOUNT, metadata: { debtId: DEBT, businessId: BIZ } },
    });

    const res = await postPaystack(payload);
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(false);

    const payments = await prisma.payment.findMany({ where: { reference } });
    expect(payments.length).toBe(1); // still one, no double reconcile

    const feed = await prisma.notification.findMany({ where: { businessId: BIZ } });
    expect(feed.length).toBe(1); // still one feed row
  });

  it('overpayment -> FULL Payment row kept, debt fully paid, Notification flags the excess amount', async () => {
    const reference = 'PAYL_webhook_ref_over';
    const charged = 250_000; // 50_000 kobo over the 200_000 principal
    const payload = JSON.stringify({
      event: 'charge.success',
      data: { reference, amount: charged, metadata: { debtId: DEBT_OVER, businessId: BIZ } },
    });

    const res = await postPaystack(payload);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, processed: true });

    // The verified charge is never trimmed: the row carries the full amount.
    const payments = await prisma.payment.findMany({ where: { reference } });
    expect(payments.length).toBe(1);
    expect(payments[0].amount).toBe(charged);

    // Paid state caps at the principal: fully paid, reminder schedule stopped.
    const debt = await prisma.debt.findUnique({ where: { id: DEBT_OVER } });
    expect(debt?.nextReminderAt).toBeNull();

    // Owner is told about the excess (₦500 = 50_000 kobo).
    const flags = await prisma.notification.findMany({
      where: { businessId: BIZ, title: 'Debt overpaid' },
    });
    expect(flags.length).toBe(1);
    expect(flags[0].kind).toBe('payment');
    expect(flags[0].body).toContain('exceeds it by ₦500.');
  });

  it('charge against an ARCHIVED debt -> Payment recorded, debt stays archived, owner notified', async () => {
    const reference = 'PAYL_webhook_ref_arch';
    const payload = JSON.stringify({
      event: 'charge.success',
      data: { reference, amount: 100_000, metadata: { debtId: DEBT_ARCH, businessId: BIZ } },
    });

    const res = await postPaystack(payload);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, processed: true });

    // The money arrived and is visible.
    const payments = await prisma.payment.findMany({ where: { reference } });
    expect(payments.length).toBe(1);
    expect(payments[0].debtId).toBe(DEBT_ARCH);
    expect(payments[0].amount).toBe(100_000);

    // NOT unarchived out-of-band.
    const debt = await prisma.debt.findUnique({ where: { id: DEBT_ARCH } });
    expect(debt?.deleted).toBe(true);

    // Owner is told an archived debt received a payment.
    const flags = await prisma.notification.findMany({
      where: { businessId: BIZ, title: 'Archived debt received a payment' },
    });
    expect(flags.length).toBe(1);
    expect(flags[0].kind).toBe('payment');
    expect(flags[0].body).toContain('archived');
  });

  it('INVALID signature -> 401 UNAUTHENTICATED and no Payment written', async () => {
    const reference = 'PAYL_webhook_ref_bad';
    const payload = JSON.stringify({
      event: 'charge.success',
      data: { reference, amount: DEBT_AMOUNT, metadata: { debtId: DEBT, businessId: BIZ } },
    });

    const res = await request(app.getHttpServer())
      .post('/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', 'deadbeef-not-a-real-hmac')
      .send(payload);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');

    const payments = await prisma.payment.findMany({ where: { reference } });
    expect(payments.length).toBe(0); // rejected before any write
    // UNVERIFIED deliveries are never logged either (untrusted input stays out of the log).
    expect(await prisma.webhookEventLog.count({ where: { reference } })).toBe(0);
  });

  it('missing signature header -> 401 (never trust an unverified payload)', async () => {
    const payload = JSON.stringify({ event: 'charge.success', data: { reference: 'x', amount: 1 } });
    const res = await request(app.getHttpServer())
      .post('/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  // --- POST /webhooks/iap ----------------------------------------------------

  it('malformed IAP notification (missing receipt) -> 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/webhooks/iap')
      .set('Content-Type', 'application/json')
      .send({ platform: 'android', productId: PLAN_PRODUCT });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('UNBOUND transaction -> 200 ignore: body.businessId is NEVER trusted, no state change', async () => {
    const res = await request(app.getHttpServer())
      .post('/webhooks/iap')
      .set('Content-Type', 'application/json')
      .send({
        platform: 'android',
        productId: PLAN_PRODUCT,
        receipt: 'iap-unknown-1', // txn-iap-unknown-1 has NO BillingTransaction binding
        businessId: BIZ_SPOOF, // attacker-supplied tenant on the raw body
        notificationType: 'SUBSCRIBED',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, processed: false });

    // No entitlement, plan, or transaction was created for the spoofed tenant.
    const spoofed = await prisma.business.findUnique({ where: { id: BIZ_SPOOF } });
    expect(spoofed?.plan).toBe('starter');
    expect(await prisma.subscription.findUnique({ where: { businessId: BIZ_SPOOF } })).toBeNull();
    expect(
      await prisma.billingTransaction.findUnique({ where: { id: 'txn-iap-unknown-1' } }),
    ).toBeNull();
  });

  it('BOUND subscription renewal with a SPOOFED body.businessId -> applies to the bound tenant only', async () => {
    const res = await request(app.getHttpServer())
      .post('/webhooks/iap')
      .set('Content-Type', 'application/json')
      .send({
        platform: 'ios',
        productId: PLAN_PRODUCT,
        receipt: BOUND_SUB_RECEIPT, // txn-iap-sub-1 is bound to BIZ_IAP at verify-receipt time
        businessId: BIZ_SPOOF, // spoof attempt: must be ignored
        notificationType: 'DID_RENEW',
      }); // no Authorization header -> proves the route is @Public

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, processed: true });

    // The BOUND tenant got the renewal.
    const bound = await prisma.business.findUnique({ where: { id: BIZ_IAP } });
    expect(bound?.plan).toBe('business');
    const sub = await prisma.subscription.findUnique({ where: { businessId: BIZ_IAP } });
    expect(sub?.entitlementState).toBe('active');
    expect(sub?.activePlanId).toBe('business');
    expect(sub?.renewalAt).not.toBeNull();

    // The SPOOFED tenant is untouched.
    const spoofed = await prisma.business.findUnique({ where: { id: BIZ_SPOOF } });
    expect(spoofed?.plan).toBe('starter');
    expect(await prisma.subscription.findUnique({ where: { businessId: BIZ_SPOOF } })).toBeNull();

    // Instrumentation: one webhook_event_log row keyed on the STORE transaction id.
    const logs = await prisma.webhookEventLog.findMany({
      where: { source: 'iap', reference: `txn-${BOUND_SUB_RECEIPT}`, eventType: 'DID_RENEW' },
    });
    expect(logs.length).toBe(1);
    expect(logs[0].outcome).toBe('ok');
  });

  it('BOUND credits-bundle transaction -> idempotent no-op (already credited at verify-receipt time)', async () => {
    const res = await request(app.getHttpServer())
      .post('/webhooks/iap')
      .set('Content-Type', 'application/json')
      .send({
        platform: 'android',
        productId: 'oweme_credits_600',
        receipt: BOUND_BUNDLE_RECEIPT, // txn-iap-bundle-1 bound to BIZ_IAP
        businessId: BIZ_SPOOF,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, processed: false });

    // No ledger was created or credited by the webhook for either tenant.
    expect(await prisma.creditLedger.findUnique({ where: { businessId: BIZ_IAP } })).toBeNull();
    expect(await prisma.creditLedger.findUnique({ where: { businessId: BIZ_SPOOF } })).toBeNull();

    // No duplicate BillingTransaction rows.
    const txns = await prisma.billingTransaction.findMany({ where: { businessId: BIZ_IAP } });
    expect(txns.length).toBe(2); // exactly the two seeded bindings
  });

  it('BOUND subscription EXPIRED -> bound tenant fails closed to starter', async () => {
    const res = await request(app.getHttpServer())
      .post('/webhooks/iap')
      .set('Content-Type', 'application/json')
      .send({
        platform: 'ios',
        productId: PLAN_PRODUCT,
        receipt: BOUND_SUB_RECEIPT,
        notificationType: 'EXPIRED',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, processed: true });

    const bound = await prisma.business.findUnique({ where: { id: BIZ_IAP } });
    expect(bound?.plan).toBe('starter');
    const sub = await prisma.subscription.findUnique({ where: { businessId: BIZ_IAP } });
    expect(sub?.entitlementState).toBe('expired');
    expect(sub?.activePlanId).toBe('starter');
    expect(sub?.renewalAt).toBeNull();
  });
});
