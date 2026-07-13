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
import { CreditLedgerService } from '../../usage/credit-ledger.service';
import { WebhooksModule } from '../webhooks.module';

/**
 * Webhooks (contract). Boots a real Nest app with the SAME global guards (JwtAuthGuard +
 * RolesGuard), HttpExceptionFilter and ValidationPipe as app.module, and with rawBody enabled
 * (Paystack signs the raw request body).
 *
 * PAYSTACK_GATEWAY is overridden with a verifier that does a REAL HMAC-SHA512 check against a
 * known webhook secret (the default stub accepts any signature, which cannot prove rejection).
 * RECEIPT_VERIFIER is overridden with a deterministic stub whose transaction id is keyed on the
 * receipt string, so re-posting the same IAP notification is idempotent.
 */

const PAYSTACK_SECRET = 'test-paystack-webhook-secret';

/** HMAC-SHA512 over the raw body — the real Paystack signature scheme. */
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

/** IAP verifier: always valid; transaction id keyed on the receipt (idempotency probe). */
class StubReceiptVerifier implements ReceiptVerifier {
  async verify(input: VerifyReceiptInput): Promise<VerifyReceiptResult> {
    return { valid: true, transactionId: `txn-${input.receipt}`, productId: input.productId };
  }
}

const sign = (raw: string): string => createHmac('sha512', PAYSTACK_SECRET).update(raw).digest('hex');

describe('Webhooks (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let credits: CreditLedgerService;

  // Distinctive tenant ids so this suite never collides with other waves' seeded rows.
  const BIZ = '01912ddd-eeee-7fff-8aaa-webhooks000biz';
  const CUSTOMER = '01912ddd-eeee-7fff-8aaa-webhooks00cust';
  const DEBT = '01912ddd-eeee-7fff-8aaa-webhooks00debt';
  const BIZ_IAP = '01912ddd-eeee-7fff-8aaa-webhooks00iapb';

  const DEBT_AMOUNT = 500_000; // kobo

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
    credits = app.get(CreditLedgerService);
    await app.init();

    await prisma.business.upsert({
      where: { id: BIZ },
      create: {
        id: BIZ,
        businessName: 'Webhook Co',
        ownerName: 'Ada Owner',
        phone: '08010000000',
        category: 'Retail',
        currency: 'NGN (₦)',
        reminderTone: 'gentle',
      },
      update: {},
    });
    await prisma.business.upsert({
      where: { id: BIZ_IAP },
      create: {
        id: BIZ_IAP,
        businessName: 'IAP Co',
        ownerName: 'Bola Owner',
        phone: '08020000000',
        category: 'Retail',
        currency: 'NGN (₦)',
        reminderTone: 'gentle',
      },
      update: {},
    });
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
  });

  afterAll(async () => {
    await app.close();
  });

  // --- POST /webhooks/paystack ----------------------------------------------

  it('valid signature + charge.success (no JWT) -> 200 and records a Payment; debt settled', async () => {
    const reference = 'PAYL_webhook_ref_1';
    const payload = JSON.stringify({
      event: 'charge.success',
      data: { reference, amount: DEBT_AMOUNT, metadata: { debtId: DEBT, businessId: BIZ } },
    });

    const res = await request(app.getHttpServer())
      .post('/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', sign(payload))
      .send(payload); // NOTE: no Authorization header -> proves the route is @Public

    expect(res.status).toBe(200);

    const payments = await prisma.payment.findMany({ where: { reference } });
    expect(payments.length).toBe(1);
    expect(payments[0].debtId).toBe(DEBT);
    expect(payments[0].amount).toBe(DEBT_AMOUNT);
    expect(payments[0].method).toBe('Paystack link');

    // Balance reached 0 -> reminder schedule stopped.
    const debt = await prisma.debt.findUnique({ where: { id: DEBT } });
    expect(debt?.nextReminderAt).toBeNull();
  });

  it('re-post the SAME reference -> idempotent (no duplicate Payment)', async () => {
    const reference = 'PAYL_webhook_ref_1';
    const payload = JSON.stringify({
      event: 'charge.success',
      data: { reference, amount: DEBT_AMOUNT, metadata: { debtId: DEBT, businessId: BIZ } },
    });

    const res = await request(app.getHttpServer())
      .post('/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', sign(payload))
      .send(payload);

    expect(res.status).toBe(200);
    const payments = await prisma.payment.findMany({ where: { reference } });
    expect(payments.length).toBe(1); // still one — no double reconcile
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

  it('valid unified-credits IAP event (no JWT) -> 200, credits ledger + records credits-bundle', async () => {
    const before = await credits.getBalance(BIZ_IAP); // lazily inits (plan grant)

    const res = await request(app.getHttpServer())
      .post('/webhooks/iap')
      .set('Content-Type', 'application/json')
      .send({
        platform: 'android',
        productId: 'oweme_credits_600',
        receipt: 'iap-receipt-1',
        businessId: BIZ_IAP,
        notificationType: 'CONSUMPTION_REQUEST',
      }); // no Authorization header -> proves the route is @Public

    expect(res.status).toBe(200);
    expect(await credits.getBalance(BIZ_IAP)).toBe(before + 600);

    const txns = await prisma.billingTransaction.findMany({ where: { businessId: BIZ_IAP } });
    expect(txns.length).toBe(1);
    expect(txns[0].kind).toBe('credits-bundle');
    expect(txns[0].productId).toBe('oweme_credits_600');
  });

  it('re-post the SAME IAP transaction -> idempotent (no double credit)', async () => {
    const before = await credits.getBalance(BIZ_IAP);
    const res = await request(app.getHttpServer())
      .post('/webhooks/iap')
      .set('Content-Type', 'application/json')
      .send({
        platform: 'android',
        productId: 'oweme_credits_600',
        receipt: 'iap-receipt-1',
        businessId: BIZ_IAP,
      });

    expect(res.status).toBe(200);
    expect(await credits.getBalance(BIZ_IAP)).toBe(before); // unchanged

    const txns = await prisma.billingTransaction.findMany({ where: { businessId: BIZ_IAP } });
    expect(txns.length).toBe(1); // no duplicate record
  });
});
