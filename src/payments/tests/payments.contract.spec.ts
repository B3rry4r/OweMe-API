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
import { PaymentsModule } from '../payments.module';
import { DEBT_STATUS_VALUES, Role } from '../../shared';

/**
 * Payment (contract). Boots a real Nest app with the SAME global guards (JwtAuthGuard +
 * RolesGuard), HttpExceptionFilter and ValidationPipe as app.module. Seeds a tenant +
 * owner/staff + a customer + a 100000-kobo debt, then asserts the Payment contract:
 *   POST /debts/:id/payments (partial, idempotent, overpayment 422, staff allowed),
 *   GET  /payments/:id (receipt shape: payment + DebtView + business),
 *   POST /debts/:id/undo-payment (removes latest, remaining recomputes).
 * Asserts SHAPES + balance behavior + auth/role rejection — never snapshots.
 */
describe('Payment (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const BID = '01912ddd-aaaa-7eee-8fff-pay0000000001';
  const OTHER_BID = '01912ddd-aaaa-7eee-8fff-pay0000000999';
  const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret';

  const mint = (role: Role, businessId: string | null = BID): string =>
    jwt.sign({ sub: `user-${role}`, businessId, role }, { secret: JWT_SECRET, expiresIn: '1h' });

  let ownerToken: string;
  let staffToken: string;

  const CUST = '01912ddd-0000-7000-8000-0000000000ca';
  const DEBT = '01912ddd-0000-7000-8000-00000000de01'; // amount 100000 kobo
  const OTHER_DEBT = '01912ddd-0000-7000-8000-00000000de99';

  const expectPaymentShape = (p: Record<string, unknown>): void => {
    expect(typeof p.id).toBe('string');
    expect(typeof p.businessId).toBe('string');
    expect(typeof p.debtId).toBe('string');
    expect(typeof p.amount).toBe('number');
    expect(typeof p.method).toBe('string');
    expect(typeof p.reference).toBe('string');
    expect(p.reference as string).toMatch(/^OWM-\d+$/);
    expect(typeof p.createdAt).toBe('string');
    expect(typeof p.updatedAt).toBe('string');
    expect(typeof p.version).toBe('number');
  };

  const remainingOf = async (): Promise<number> => {
    const agg = await prisma.payment.aggregate({
      where: { businessId: BID, debtId: DEBT },
      _sum: { amount: true },
    });
    return 100000 - (agg._sum.amount ?? 0);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, PaymentsModule],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    await app.init();

    for (const b of [BID, OTHER_BID]) {
      await prisma.payment.deleteMany({ where: { businessId: b } });
      await prisma.debt.deleteMany({ where: { businessId: b } });
      await prisma.customer.deleteMany({ where: { businessId: b } });
    }

    for (const [id, name] of [
      [BID, 'Pay Traders'],
      [OTHER_BID, 'Other Tenant'],
    ] as const) {
      await prisma.business.upsert({
        where: { id },
        create: {
          id,
          businessName: name,
          ownerName: 'Owner',
          phone: '08030000000',
          category: 'Retail',
          currency: 'NGN (₦)',
          reminderTone: 'gentle',
          plan: 'business',
        },
        update: {},
      });
    }

    await prisma.customer.create({
      data: { id: CUST, businessId: BID, name: 'Ada Buyer', phone: '08111111111' },
    });
    await prisma.debt.create({
      data: { id: DEBT, businessId: BID, customerId: CUST, amount: 100000, note: 'goods' },
    });

    // cross-tenant noise
    await prisma.customer.create({
      data: { id: 'other-cust-pay', businessId: OTHER_BID, name: 'Zed', phone: '09999999999' },
    });
    await prisma.debt.create({
      data: { id: OTHER_DEBT, businessId: OTHER_BID, customerId: 'other-cust-pay', amount: 5000 },
    });

    ownerToken = mint('owner');
    staffToken = mint('staff');
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /debts/:id/payments with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer())
      .post(`/debts/${DEBT}/payments`)
      .send({ id: '01912ddd-0000-7000-8000-00000000p401', amount: 1000, method: 'Cash' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('POST /debts/:id/payments (partial) -> 201 Payment; re-POST same id -> idempotent (no duplicate)', async () => {
    const payId = '01912ddd-0000-7000-8000-00000000pa01';
    const first = await request(app.getHttpServer())
      .post(`/debts/${DEBT}/payments`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ id: payId, amount: 40000, method: 'Cash' });
    expect(first.status).toBe(201);
    expectPaymentShape(first.body);
    expect(first.body.id).toBe(payId);
    expect(first.body.debtId).toBe(DEBT);
    expect(first.body.businessId).toBe(BID);
    expect(first.body.amount).toBe(40000);
    expect(first.body.method).toBe('Cash');

    // remaining recomputes from the payment sum (never stored): 100000 - 40000
    expect(await remainingOf()).toBe(60000);

    // re-POST same id: idempotent — returns existing, mints no new row
    const again = await request(app.getHttpServer())
      .post(`/debts/${DEBT}/payments`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ id: payId, amount: 999, method: 'Bank transfer' });
    expect([200, 201]).toContain(again.status);
    expect(again.body.id).toBe(payId);
    expect(again.body.amount).toBe(40000); // unchanged existing row
    expect(again.body.reference).toBe(first.body.reference);

    const count = await prisma.payment.count({ where: { debtId: DEBT, businessId: BID } });
    expect(count).toBe(1);
    expect(await remainingOf()).toBe(60000);
  });

  it('POST /debts/:id/payments overpayment (> remaining) -> 422 VALIDATION_ERROR', async () => {
    // remaining is 60000; attempt 60001
    const res = await request(app.getHttpServer())
      .post(`/debts/${DEBT}/payments`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ id: '01912ddd-0000-7000-8000-00000000pov1', amount: 60001, method: 'Cash' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    // rejected — nothing recorded
    expect(await remainingOf()).toBe(60000);
  });

  it('POST /debts/:id/payments amount<=0 -> 422 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .post(`/debts/${DEBT}/payments`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ id: '01912ddd-0000-7000-8000-00000000pz01', amount: 0, method: 'Cash' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('STAFF can record a payment -> 200/201 Payment', async () => {
    const res = await request(app.getHttpServer())
      .post(`/debts/${DEBT}/payments`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ id: '01912ddd-0000-7000-8000-00000000pst1', amount: 10000, method: 'POS' });
    expect([200, 201]).toContain(res.status);
    expectPaymentShape(res.body);
    expect(res.body.amount).toBe(10000);
    expect(await remainingOf()).toBe(50000); // 100000 - 40000 - 10000
  });

  it('POST /debts/:id/payments on a cross-tenant debt -> 404 NOT_FOUND', async () => {
    const res = await request(app.getHttpServer())
      .post(`/debts/${OTHER_DEBT}/payments`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ id: '01912ddd-0000-7000-8000-00000000pxt1', amount: 100, method: 'Cash' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('GET /payments/:id -> 200 { payment, debt(DebtView), business{businessName} }', async () => {
    const payId = '01912ddd-0000-7000-8000-00000000pa01';
    const res = await request(app.getHttpServer())
      .get(`/payments/${payId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);

    expectPaymentShape(res.body.payment);
    expect(res.body.payment.id).toBe(payId);

    // embedded DebtView with derived money/status
    const d = res.body.debt as Record<string, unknown>;
    expect(d.id).toBe(DEBT);
    expect(d.amount).toBe(100000);
    expect(typeof d.paidAmount).toBe('number');
    expect(typeof d.remaining).toBe('number');
    expect(d.remaining).toBe(50000); // 40000 + 10000 recorded so far
    expect(d.paidAmount).toBe(50000);
    expect(DEBT_STATUS_VALUES).toContain(d.status);
    expect(d.status).toBe('partial');
    const c = d.customer as Record<string, unknown>;
    expect(c.id).toBe(CUST);
    expect(typeof c.name).toBe('string');
    expect(typeof c.phone).toBe('string');

    // business stub for the receipt header
    expect(res.body.business.businessName).toBe('Pay Traders');
  });

  it('GET /payments/:id unknown / cross-tenant -> 404', async () => {
    const missing = await request(app.getHttpServer())
      .get('/payments/01912ddd-0000-7000-8000-0000000deadd')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });

  it('POST /debts/:id/undo-payment -> removes the latest payment and returns it; remaining recomputes', async () => {
    // latest recorded is the 10000 POS payment (pst1)
    const before = await remainingOf();
    expect(before).toBe(50000);

    const res = await request(app.getHttpServer())
      .post(`/debts/${DEBT}/undo-payment`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect([200, 201]).toContain(res.status);
    expectPaymentShape(res.body);
    expect(res.body.amount).toBe(10000);
    expect(res.body.id).toBe('01912ddd-0000-7000-8000-00000000pst1');

    // the removed row is gone; remaining recomputes (never stored)
    const gone = await prisma.payment.findUnique({ where: { id: res.body.id } });
    expect(gone).toBeNull();
    expect(await remainingOf()).toBe(60000); // back to just the 40000 payment
  });

  it('POST /debts/:id/undo-payment when no payments remain -> 404', async () => {
    // remove the last remaining payment, then undo again -> 404
    const first = await request(app.getHttpServer())
      .post(`/debts/${DEBT}/undo-payment`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect([200, 201]).toContain(first.status);
    expect(await remainingOf()).toBe(100000); // fully reopened

    const empty = await request(app.getHttpServer())
      .post(`/debts/${DEBT}/undo-payment`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(empty.status).toBe(404);
    expect(empty.body.error.code).toBe('NOT_FOUND');
  });
});
