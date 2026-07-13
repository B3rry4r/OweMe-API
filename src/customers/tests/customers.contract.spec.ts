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
import { CustomersModule } from '../customers.module';
import {
  ACTIVITY_KIND_VALUES,
  DEBT_STATUS_VALUES,
  Role,
} from '../../shared';

/**
 * Customer (contract). Boots a real Nest app with the SAME global guards
 * (JwtAuthGuard + RolesGuard), HttpExceptionFilter and ValidationPipe as app.module.
 * Seeds a tenant + owner + customers with debts/payments/reminders across the
 * status spectrum, then asserts CustomerView aggregates, filter/sort/q + cursor
 * pagination, idempotent create, owner-only delete + debt archival, activity, and 501 risk.
 * Asserts SHAPES + status + auth/role rejection — never snapshots.
 */
describe('Customer (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const BID = '01912ccc-dddd-7eee-8fff-cust000000001';
  const OTHER_BID = '01912ccc-dddd-7eee-8fff-cust000000999';
  const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret';

  const mint = (role: Role, businessId: string | null = BID): string =>
    jwt.sign({ sub: `user-${role}`, businessId, role }, { secret: JWT_SECRET, expiresIn: '1h' });

  let ownerToken: string;
  let staffToken: string;

  // customer ids
  const C_OVERDUE = '01912ccc-0000-7000-8000-000000000001'; // owes, overdue
  const C_PARTIAL = '01912ccc-0000-7000-8000-000000000002'; // owes, partial pay, future due
  const C_PAID = '01912ccc-0000-7000-8000-000000000003'; // fully paid -> paid-up
  const C_NONE = '01912ccc-0000-7000-8000-000000000004'; // no debts -> paid-up

  const DAY = 24 * 60 * 60 * 1000;
  const iso = (ms: number) => new Date(ms).toISOString();

  const expectCustomerViewShape = (v: Record<string, unknown>): void => {
    // base Customer fields
    expect(typeof v.id).toBe('string');
    expect(typeof v.businessId).toBe('string');
    expect(typeof v.name).toBe('string');
    expect(typeof v.phone).toBe('string');
    expect(v.address === null || typeof v.address === 'string').toBe(true);
    expect(v.note === null || typeof v.note === 'string').toBe(true);
    expect(typeof v.createdAt).toBe('string');
    expect(typeof v.updatedAt).toBe('string');
    expect(typeof v.version).toBe('number');
    // computed view fields
    expect(typeof v.owed).toBe('number');
    expect(typeof v.debtCount).toBe('number');
    expect(DEBT_STATUS_VALUES).toContain(v.worstStatus);
    expect(v.lastActivityAt === null || typeof v.lastActivityAt === 'string').toBe(true);
    expect(v.lastPaymentAt === null || typeof v.lastPaymentAt === 'string').toBe(true);
    expect(v.lastReminderAt === null || typeof v.lastReminderAt === 'string').toBe(true);
    expect(v.earliestOverdueDue === null || typeof v.earliestOverdueDue === 'string').toBe(true);
  };

  const byId = (data: Array<Record<string, unknown>>, id: string) => data.find((v) => v.id === id);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, CustomersModule],
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

    // Clean any prior run for these tenants.
    for (const b of [BID, OTHER_BID]) {
      await prisma.reminder.deleteMany({ where: { businessId: b } });
      await prisma.payment.deleteMany({ where: { businessId: b } });
      await prisma.debt.deleteMany({ where: { businessId: b } });
      await prisma.customer.deleteMany({ where: { businessId: b } });
    }

    for (const [id, name] of [
      [BID, 'Aggregate Traders'],
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

    const now = Date.now();

    // --- C_OVERDUE: one open debt of 10000, no payment, due 5 days ago (overdue) ---
    await prisma.customer.create({
      data: { id: C_OVERDUE, businessId: BID, name: 'Amaka Overdue', phone: '08111111111' },
    });
    await prisma.debt.create({
      data: {
        id: 'debt-overdue-1',
        businessId: BID,
        customerId: C_OVERDUE,
        amount: 10000,
        dueDate: new Date(now - 5 * DAY),
        createdAt: new Date(now - 10 * DAY),
      },
    });

    // --- C_PARTIAL: debt 20000 with a 5000 payment, future due (partial, owed 15000) ---
    await prisma.customer.create({
      data: { id: C_PARTIAL, businessId: BID, name: 'Bola Partial', phone: '08222222222' },
    });
    await prisma.debt.create({
      data: {
        id: 'debt-partial-1',
        businessId: BID,
        customerId: C_PARTIAL,
        amount: 20000,
        dueDate: new Date(now + 5 * DAY),
        createdAt: new Date(now - 3 * DAY),
      },
    });
    await prisma.payment.create({
      data: {
        id: 'pay-partial-1',
        businessId: BID,
        debtId: 'debt-partial-1',
        amount: 5000,
        method: 'Cash',
        reference: 'OWM-00001',
        createdAt: new Date(now - 1 * DAY),
      },
    });
    await prisma.reminder.create({
      data: {
        id: 'rem-partial-1',
        businessId: BID,
        debtId: 'debt-partial-1',
        channel: 'sms',
        status: 'sent',
        sentAt: new Date(now - 2 * DAY),
      },
    });

    // --- C_PAID: debt 8000 fully paid (owed 0, paid-up) ---
    await prisma.customer.create({
      data: { id: C_PAID, businessId: BID, name: 'Chidi Paid', phone: '08333333333' },
    });
    await prisma.debt.create({
      data: { id: 'debt-paid-1', businessId: BID, customerId: C_PAID, amount: 8000 },
    });
    await prisma.payment.create({
      data: {
        id: 'pay-paid-1',
        businessId: BID,
        debtId: 'debt-paid-1',
        amount: 8000,
        method: 'Bank transfer',
        reference: 'OWM-00002',
        createdAt: new Date(now - 4 * DAY),
      },
    });

    // --- C_NONE: no debts (paid-up, owed 0) ---
    await prisma.customer.create({
      data: { id: C_NONE, businessId: BID, name: 'Dara None', phone: '08444444444' },
    });

    // Cross-tenant noise: another business's customer must never leak in.
    await prisma.customer.create({
      data: { id: 'other-cust-1', businessId: OTHER_BID, name: 'Zed Foreign', phone: '09999999999' },
    });

    ownerToken = mint('owner');
    staffToken = mint('staff');
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /customers with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer()).get('/customers');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('GET /customers as staff -> 200 Paginated<CustomerView> with correct aggregates', async () => {
    const res = await request(app.getHttpServer())
      .get('/customers')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect('nextCursor' in res.body).toBe(true);
    res.body.data.forEach((v: Record<string, unknown>) => expectCustomerViewShape(v));

    // tenant isolation: the other business's customer is absent
    expect(byId(res.body.data, 'other-cust-1')).toBeUndefined();

    const overdue = byId(res.body.data, C_OVERDUE)!;
    expect(overdue.owed).toBe(10000);
    expect(overdue.debtCount).toBe(1);
    expect(overdue.worstStatus).toBe('overdue');
    expect(typeof overdue.earliestOverdueDue).toBe('string');

    const partial = byId(res.body.data, C_PARTIAL)!;
    expect(partial.owed).toBe(15000); // 20000 - 5000
    expect(partial.debtCount).toBe(1);
    expect(partial.worstStatus).toBe('partial');
    expect(partial.earliestOverdueDue).toBeNull();
    expect(typeof partial.lastPaymentAt).toBe('string');
    expect(typeof partial.lastReminderAt).toBe('string');

    const paid = byId(res.body.data, C_PAID)!;
    expect(paid.owed).toBe(0);
    expect(paid.debtCount).toBe(0);
    expect(paid.worstStatus).toBe('paid');

    const none = byId(res.body.data, C_NONE)!;
    expect(none.owed).toBe(0);
    expect(none.debtCount).toBe(0);
    expect(none.worstStatus).toBe('paid');
    expect(none.lastActivityAt).toBeNull();
  });

  it('GET /customers?filter=owing -> only customers with owed>0', async () => {
    const res = await request(app.getHttpServer())
      .get('/customers?filter=owing')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((v: Record<string, unknown>) => v.id);
    expect(ids).toContain(C_OVERDUE);
    expect(ids).toContain(C_PARTIAL);
    expect(ids).not.toContain(C_PAID);
    expect(ids).not.toContain(C_NONE);
  });

  it('GET /customers?filter=overdue -> only customers with an overdue open debt', async () => {
    const res = await request(app.getHttpServer())
      .get('/customers?filter=overdue')
      .set('Authorization', `Bearer ${ownerToken}`);
    const ids = res.body.data.map((v: Record<string, unknown>) => v.id);
    expect(ids).toContain(C_OVERDUE);
    expect(ids).not.toContain(C_PARTIAL);
    expect(ids).not.toContain(C_PAID);
  });

  it('GET /customers?filter=paid-up -> only customers with no open debts', async () => {
    const res = await request(app.getHttpServer())
      .get('/customers?filter=paid-up')
      .set('Authorization', `Bearer ${ownerToken}`);
    const ids = res.body.data.map((v: Record<string, unknown>) => v.id);
    expect(ids).toContain(C_PAID);
    expect(ids).toContain(C_NONE);
    expect(ids).not.toContain(C_OVERDUE);
  });

  it('GET /customers?sort=most-owed -> descending owed', async () => {
    const res = await request(app.getHttpServer())
      .get('/customers?sort=most-owed')
      .set('Authorization', `Bearer ${ownerToken}`);
    const owed = res.body.data.map((v: Record<string, unknown>) => v.owed as number);
    const sorted = [...owed].sort((a, b) => b - a);
    expect(owed).toEqual(sorted);
    expect(res.body.data[0].id).toBe(C_PARTIAL); // 15000 is the largest owed
  });

  it('GET /customers?sort=name -> ascending by name', async () => {
    const res = await request(app.getHttpServer())
      .get('/customers?sort=name')
      .set('Authorization', `Bearer ${ownerToken}`);
    const names = res.body.data.map((v: Record<string, unknown>) => v.name as string);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('GET /customers?q= matches name substring and phone digits (traditional search)', async () => {
    const byName = await request(app.getHttpServer())
      .get('/customers?q=Amaka')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(byName.body.data.map((v: Record<string, unknown>) => v.id)).toEqual([C_OVERDUE]);

    const byPhone = await request(app.getHttpServer())
      .get('/customers?q=08222222222')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(byPhone.body.data.map((v: Record<string, unknown>) => v.id)).toEqual([C_PARTIAL]);
  });

  it('GET /customers?limit=2 -> nextCursor paginates the roster without overlap', async () => {
    const p1 = await request(app.getHttpServer())
      .get('/customers?sort=name&limit=2')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(p1.body.data.length).toBe(2);
    expect(typeof p1.body.nextCursor).toBe('string');

    const p2 = await request(app.getHttpServer())
      .get(`/customers?sort=name&limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(p2.status).toBe(200);
    const firstIds = new Set(p1.body.data.map((v: Record<string, unknown>) => v.id));
    p2.body.data.forEach((v: Record<string, unknown>) => expect(firstIds.has(v.id)).toBe(false));
  });

  it('GET /customers/:id -> 200 CustomerView; unknown id -> 404', async () => {
    const res = await request(app.getHttpServer())
      .get(`/customers/${C_OVERDUE}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expectCustomerViewShape(res.body);
    expect(res.body.id).toBe(C_OVERDUE);
    expect(res.body.owed).toBe(10000);

    const missing = await request(app.getHttpServer())
      .get('/customers/01912ccc-0000-7000-8000-00000000dead')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });

  it('GET /customers/:id cross-tenant -> 404 (isolation)', async () => {
    const res = await request(app.getHttpServer())
      .get('/customers/other-cust-1')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });

  it('POST /customers -> 201 Customer; re-POST same id -> 200 existing (idempotent)', async () => {
    const id = '01912ccc-0000-7000-8000-0000000000aa';
    const payload = { id, name: 'New Customer', phone: '08055555555', note: 'hi' };

    const first = await request(app.getHttpServer())
      .post('/customers')
      .set('Authorization', `Bearer ${staffToken}`)
      .send(payload);
    expect(first.status).toBe(201);
    expect(first.body.id).toBe(id);
    expect(first.body.businessId).toBe(BID);
    expect(first.body.name).toBe('New Customer');
    expect(typeof first.body.version).toBe('number');

    const again = await request(app.getHttpServer())
      .post('/customers')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ ...payload, name: 'Changed Name' });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(id);
    expect(again.body.name).toBe('New Customer'); // unchanged existing row
  });

  it('POST /customers with invalid body -> 422 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .post('/customers')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'No Id Or Phone' }); // missing id + phone
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /customers/:id/activity -> 200 ActivityItem[] (at desc)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/customers/${C_PARTIAL}/activity`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(3); // debt + payment + reminder
    res.body.forEach((it: Record<string, unknown>) => {
      expect(ACTIVITY_KIND_VALUES).toContain(it.kind);
      expect(typeof it.title).toBe('string');
      expect(typeof it.subtitle).toBe('string');
      expect(it.amount === null || typeof it.amount === 'number').toBe(true);
      expect(typeof it.at).toBe('string');
    });
    const times = res.body.map((it: Record<string, unknown>) => Date.parse(it.at as string));
    expect(times).toEqual([...times].sort((a, b) => b - a)); // desc
    const kinds = res.body.map((it: Record<string, unknown>) => it.kind);
    expect(kinds).toContain('payment');
    expect(kinds).toContain('debt');
    expect(kinds).toContain('reminder');
  });

  it('GET /customers/:id/risk -> 501 (scaffold)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/customers/${C_OVERDUE}/risk`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(501);
  });

  it('DELETE /customers/:id as STAFF -> 403 FORBIDDEN (owner-only)', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/customers/${C_OVERDUE}`)
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');

    // still present + debt not archived
    const debt = await prisma.debt.findUnique({ where: { id: 'debt-overdue-1' } });
    expect(debt?.deleted).toBe(false);
  });

  it('DELETE /customers/:id as OWNER -> 200 Customer; soft-deletes customer + archives its debts', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/customers/${C_OVERDUE}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(C_OVERDUE);

    // the returned row is the now-deleted customer (soft-delete flag set, version bumped)
    const row = await prisma.customer.findUnique({ where: { id: C_OVERDUE } });
    expect(row?.deleted).toBe(true); // soft-deleted, not hard-deleted
    expect(row?.version).toBeGreaterThan(0);

    const debt = await prisma.debt.findUnique({ where: { id: 'debt-overdue-1' } });
    expect(debt?.deleted).toBe(true); // archived, not hard-deleted

    // soft-deleted customer is gone from single-fetch (404, same as a missing id)...
    const view = await request(app.getHttpServer())
      .get(`/customers/${C_OVERDUE}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(view.status).toBe(404);
    expect(view.body.error.code).toBe('NOT_FOUND');

    // ...and no longer listed in the roster
    const list = await request(app.getHttpServer())
      .get('/customers')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(list.status).toBe(200);
    expect(byId(list.body.data, C_OVERDUE)).toBeUndefined();

    // activity on a soft-deleted customer also 404s
    const activity = await request(app.getHttpServer())
      .get(`/customers/${C_OVERDUE}/activity`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(activity.status).toBe(404);
  });

  it('DELETE /customers/:id with no token -> 401', async () => {
    const res = await request(app.getHttpServer()).delete(`/customers/${C_PAID}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});
