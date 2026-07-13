import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { CommonModule } from '../../common/common.module';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  RECEIPT_VERIFIER,
  ReceiptVerifier,
  VerifyReceiptInput,
  VerifyReceiptResult,
} from '../../common';
import { CreditLedgerService } from '../../usage/credit-ledger.service';
import { SendAllowanceService } from '../../usage/send-allowance.service';
import { Role } from '../../shared';
import { BillingModule } from '../billing.module';

/**
 * Billing / Subscription (contract). Boots a real Nest app with the SAME global guards
 * (JwtAuthGuard + RolesGuard), HttpExceptionFilter and ValidationPipe as app.module.
 * RECEIPT_VERIFIER is overridden with a deterministic stub that returns a valid receipt +
 * a transaction id derived from the receipt string (so a re-verify of the same receipt is
 * idempotent). Plan catalog is seeded by the jest globalSetup.
 */

/** Stub verifier: always valid; transaction id keyed on the receipt (idempotency probe). */
class StubVerifier implements ReceiptVerifier {
  async verify(input: VerifyReceiptInput): Promise<VerifyReceiptResult> {
    return { valid: true, transactionId: `txn-${input.receipt}`, productId: input.productId };
  }
}

describe('Billing / Subscription (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let credits: CreditLedgerService;
  let sends: SendAllowanceService;

  const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret';

  // Distinctive tenant ids so this suite never collides with other waves' seeded rows.
  const BIZ_SUB = '01912bbb-cccc-7ddd-8eee-billing0000sub';
  const BIZ_PLAN = '01912bbb-cccc-7ddd-8eee-billing000plan';
  const BIZ_AI = '01912bbb-cccc-7ddd-8eee-billing00000ai';
  const BIZ_SEND = '01912bbb-cccc-7ddd-8eee-billing00send0';

  const mintToken = (role: Role, businessId: string): string =>
    jwt.sign({ sub: `user-${role}`, businessId, role }, { secret: JWT_SECRET, expiresIn: '1h' });

  const seedBusiness = (id: string, plan = 'starter'): Promise<unknown> =>
    prisma.business.upsert({
      where: { id },
      create: {
        id,
        businessName: 'Billing Co',
        ownerName: 'Ada Owner',
        phone: '08010000000',
        category: 'Retail',
        currency: 'NGN (₦)',
        reminderTone: 'gentle',
        plan,
      },
      update: { plan },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, BillingModule],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideProvider(RECEIPT_VERIFIER)
      .useClass(StubVerifier)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    credits = app.get(CreditLedgerService);
    sends = app.get(SendAllowanceService);
    await app.init();

    await seedBusiness(BIZ_SUB);
    await seedBusiness(BIZ_PLAN);
    await seedBusiness(BIZ_AI);
    await seedBusiness(BIZ_SEND);
  });

  afterAll(async () => {
    await app.close();
  });

  // --- GET /subscription ----------------------------------------------------
  it('GET /subscription as owner -> 200 default entitlement shape (starter/none)', async () => {
    const res = await request(app.getHttpServer())
      .get('/subscription')
      .set('Authorization', `Bearer ${mintToken('owner', BIZ_SUB)}`);

    expect(res.status).toBe(200);
    expect(res.body.planId).toBe('starter');
    expect(res.body.entitlementState).toBe('none');
    expect(res.body.activePlanId).toBe('starter');
    expect(res.body.renewalAt).toBeNull();
    // shape assertions
    expect(typeof res.body.planId).toBe('string');
    expect(typeof res.body.entitlementState).toBe('string');
    expect(typeof res.body.activePlanId).toBe('string');
  });

  it('GET /subscription with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer()).get('/subscription');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('GET /subscription as staff -> 403 FORBIDDEN (owner-only)', async () => {
    const res = await request(app.getHttpServer())
      .get('/subscription')
      .set('Authorization', `Bearer ${mintToken('staff', BIZ_SUB)}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  // --- POST /billing/verify-receipt : PLAN product --------------------------
  it('verify-receipt PLAN product -> 200 entitlement active + Business.plan updated', async () => {
    const res = await request(app.getHttpServer())
      .post('/billing/verify-receipt')
      .set('Authorization', `Bearer ${mintToken('owner', BIZ_PLAN)}`)
      .send({ platform: 'ios', productId: 'oweme_market_monthly', receipt: 'plan-receipt-1' });

    expect(res.status).toBe(201);
    expect(res.body.entitlement).toBeDefined();
    expect(res.body.entitlement.planId).toBe('market');
    expect(res.body.entitlement.entitlementState).toBe('active');
    expect(res.body.entitlement.activePlanId).toBe('market');
    expect(typeof res.body.entitlement.renewalAt).toBe('string');

    const business = await prisma.business.findUnique({ where: { id: BIZ_PLAN } });
    expect(business?.plan).toBe('market');

    const txns = await prisma.billingTransaction.findMany({ where: { businessId: BIZ_PLAN } });
    expect(txns.length).toBe(1);
    expect(txns[0].kind).toBe('subscription');
  });

  it('re-verify same PLAN tx -> idempotent (no duplicate BillingTransaction)', async () => {
    const res = await request(app.getHttpServer())
      .post('/billing/verify-receipt')
      .set('Authorization', `Bearer ${mintToken('owner', BIZ_PLAN)}`)
      .send({ platform: 'ios', productId: 'oweme_market_monthly', receipt: 'plan-receipt-1' });

    expect(res.status).toBe(201);
    expect(res.body.entitlement.entitlementState).toBe('active');

    const txns = await prisma.billingTransaction.findMany({ where: { businessId: BIZ_PLAN } });
    expect(txns.length).toBe(1); // still one — no double record
  });

  // --- POST /billing/verify-receipt : AI-credit bundle ----------------------
  it('verify-receipt AI-credit bundle -> credits the AI ledger (balance rose)', async () => {
    const before = await credits.getBalance(BIZ_AI); // lazily initializes (starter grant = 10)

    const res = await request(app.getHttpServer())
      .post('/billing/verify-receipt')
      .set('Authorization', `Bearer ${mintToken('owner', BIZ_AI)}`)
      .send({ platform: 'android', productId: 'oweme_ai_credits_50', receipt: 'ai-receipt-1' });

    expect(res.status).toBe(201);
    expect(res.body.ledger).toBeDefined();
    expect(res.body.ledger.aiCredits).toBe(before + 50);
    expect(await credits.getBalance(BIZ_AI)).toBe(before + 50);
  });

  it('re-verify same AI bundle tx -> idempotent (balance unchanged)', async () => {
    const before = await credits.getBalance(BIZ_AI);
    await request(app.getHttpServer())
      .post('/billing/verify-receipt')
      .set('Authorization', `Bearer ${mintToken('owner', BIZ_AI)}`)
      .send({ platform: 'android', productId: 'oweme_ai_credits_50', receipt: 'ai-receipt-1' });
    expect(await credits.getBalance(BIZ_AI)).toBe(before); // no double credit
  });

  // --- POST /billing/verify-receipt : message bundle ------------------------
  it('verify-receipt message bundle -> credits the send allowance', async () => {
    const before = await sends.getRemaining(BIZ_SEND); // lazily initializes (starter grant = 10)

    const res = await request(app.getHttpServer())
      .post('/billing/verify-receipt')
      .set('Authorization', `Bearer ${mintToken('owner', BIZ_SEND)}`)
      .send({ platform: 'ios', productId: 'oweme_sends_150', receipt: 'send-receipt-1' });

    expect(res.status).toBe(201);
    expect(res.body.ledger).toBeDefined();
    expect(res.body.ledger.sendAllowance).toBe(before + 150);
    expect(await sends.getRemaining(BIZ_SEND)).toBe(before + 150);
  });

  // --- POST /billing/verify-receipt : validation ----------------------------
  it('verify-receipt invalid platform -> 422 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .post('/billing/verify-receipt')
      .set('Authorization', `Bearer ${mintToken('owner', BIZ_SEND)}`)
      .send({ platform: 'windows', productId: 'oweme_sends_150', receipt: 'x' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('verify-receipt as staff -> 403 FORBIDDEN (owner-only)', async () => {
    const res = await request(app.getHttpServer())
      .post('/billing/verify-receipt')
      .set('Authorization', `Bearer ${mintToken('staff', BIZ_SEND)}`)
      .send({ platform: 'ios', productId: 'oweme_sends_150', receipt: 'y' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  // --- GET /billing/history -------------------------------------------------
  it('GET /billing/history as owner -> 200 Paginated<BillingTransaction>', async () => {
    const res = await request(app.getHttpServer())
      .get('/billing/history')
      .set('Authorization', `Bearer ${mintToken('owner', BIZ_PLAN)}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect('nextCursor' in res.body).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);

    const tx = res.body.data[0];
    expect(typeof tx.id).toBe('string');
    expect(typeof tx.businessId).toBe('string');
    expect(typeof tx.kind).toBe('string');
    expect(typeof tx.productId).toBe('string');
    expect(typeof tx.label).toBe('string');
    expect(typeof tx.amount).toBe('number'); // kobo
    expect(typeof tx.createdAt).toBe('string');
  });

  it('GET /billing/history as staff -> 403 FORBIDDEN', async () => {
    const res = await request(app.getHttpServer())
      .get('/billing/history')
      .set('Authorization', `Bearer ${mintToken('staff', BIZ_PLAN)}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('GET /billing/history with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer()).get('/billing/history');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});
