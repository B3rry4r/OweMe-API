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
import { PAYSTACK_GATEWAY } from '../../common/providers/tokens';
import { DebtsModule } from '../debts.module';
import {
  DEBT_STATUS_VALUES,
  REMINDER_CHANNEL_VALUES,
  REMINDER_STATUS_VALUES,
  Role,
} from '../../shared';

/**
 * Debt (contract). Boots a real Nest app with the SAME global guards (JwtAuthGuard +
 * RolesGuard), HttpExceptionFilter and ValidationPipe as app.module. Overrides
 * PAYSTACK_GATEWAY with a stub for pay-link. Seeds a tenant + owner/staff + customers +
 * debts across the status spectrum with payments/reminders, then asserts DebtView derivation
 * (paidAmount/remaining/status), status/sort/q + cursor pagination, idempotent create,
 * If-Match version sync, owner-only soft delete + restore, pay-link, and the sub-lists.
 * Asserts SHAPES + status + auth/role rejection — never snapshots.
 */
describe('Debt (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const BID = '01912ddd-aaaa-7eee-8fff-debt000000001';
  const OTHER_BID = '01912ddd-aaaa-7eee-8fff-debt000000999';
  const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret';

  const mint = (role: Role, businessId: string | null = BID): string =>
    jwt.sign({ sub: `user-${role}`, businessId, role }, { secret: JWT_SECRET, expiresIn: '1h' });

  let ownerToken: string;
  let staffToken: string;

  const PAY_URL = 'https://paystack.test/checkout/DEBT-STUB';

  // customers
  const C1 = '01912ddd-0000-7000-8000-0000000000c1';
  const C2 = '01912ddd-0000-7000-8000-0000000000c2';
  const C3 = '01912ddd-0000-7000-8000-0000000000c3';
  const C4 = '01912ddd-0000-7000-8000-0000000000c4';

  // debts
  const D_OVERDUE = '01912ddd-0000-7000-8000-00000000d001'; // 10000, due -5d, no pay -> overdue
  const D_PARTIAL = '01912ddd-0000-7000-8000-00000000d002'; // 20000, pay 5000, due +5d -> partial
  const D_PAID = '01912ddd-0000-7000-8000-00000000d003'; // 8000 fully paid -> paid
  const D_SCHEDULED = '01912ddd-0000-7000-8000-00000000d004'; // 5000, due +10d -> scheduled
  const D_ARCHIVED = '01912ddd-0000-7000-8000-00000000d005'; // deleted=true

  const DAY = 24 * 60 * 60 * 1000;
  const byId = (data: Array<Record<string, unknown>>, id: string) => data.find((v) => v.id === id);

  const expectDebtViewShape = (v: Record<string, unknown>): void => {
    expect(typeof v.id).toBe('string');
    expect(typeof v.businessId).toBe('string');
    expect(typeof v.customerId).toBe('string');
    expect(typeof v.amount).toBe('number');
    expect(v.note === null || typeof v.note === 'string').toBe(true);
    expect(v.dueDate === null || typeof v.dueDate === 'string').toBe(true);
    expect(typeof v.createdAt).toBe('string');
    expect(v.lastReminderAt === null || typeof v.lastReminderAt === 'string').toBe(true);
    expect(v.nextReminderAt === null || typeof v.nextReminderAt === 'string').toBe(true);
    expect(typeof v.deleted).toBe('boolean');
    expect(typeof v.updatedAt).toBe('string');
    expect(typeof v.version).toBe('number');
    // derived view fields
    expect(typeof v.paidAmount).toBe('number');
    expect(typeof v.remaining).toBe('number');
    expect(DEBT_STATUS_VALUES).toContain(v.status);
    const c = v.customer as Record<string, unknown>;
    expect(typeof c.id).toBe('string');
    expect(typeof c.name).toBe('string');
    expect(typeof c.phone).toBe('string');
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, DebtsModule],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideProvider(PAYSTACK_GATEWAY)
      .useValue({
        createPaymentRequest: jest.fn(async (input: { reference: string }) => ({
          url: PAY_URL,
          reference: input.reference,
        })),
        listBanks: jest.fn(),
        resolveAccount: jest.fn(),
        createSubaccount: jest.fn(),
        verifySignature: jest.fn(() => true),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    await app.init();

    for (const b of [BID, OTHER_BID]) {
      await prisma.reminder.deleteMany({ where: { businessId: b } });
      await prisma.payment.deleteMany({ where: { businessId: b } });
      await prisma.debt.deleteMany({ where: { businessId: b } });
      await prisma.customer.deleteMany({ where: { businessId: b } });
    }

    for (const [id, name] of [
      [BID, 'Debt Traders'],
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
          paystackSubaccount: 'ACCT_stub_0001',
        },
        update: { paystackSubaccount: 'ACCT_stub_0001' },
      });
    }

    const now = Date.now();

    for (const [id, name, phone] of [
      [C1, 'Amaka Overdue', '08111111111'],
      [C2, 'Bola Partial', '08222222222'],
      [C3, 'Chidi Paid', '08333333333'],
      [C4, 'Dara Scheduled', '08444444444'],
    ] as const) {
      await prisma.customer.create({ data: { id, businessId: BID, name, phone } });
    }

    // D_OVERDUE — 10000, due 5 days ago, no payment
    await prisma.debt.create({
      data: {
        id: D_OVERDUE,
        businessId: BID,
        customerId: C1,
        amount: 10000,
        note: 'engine parts',
        dueDate: new Date(now - 5 * DAY),
        createdAt: new Date(now - 10 * DAY),
      },
    });

    // D_PARTIAL — 20000 with a 5000 payment + a sent reminder, due +5 days
    await prisma.debt.create({
      data: {
        id: D_PARTIAL,
        businessId: BID,
        customerId: C2,
        amount: 20000,
        dueDate: new Date(now + 5 * DAY),
        createdAt: new Date(now - 3 * DAY),
        lastReminderAt: new Date(now - 2 * DAY),
      },
    });
    await prisma.payment.create({
      data: {
        id: 'pay-partial-1',
        businessId: BID,
        debtId: D_PARTIAL,
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
        debtId: D_PARTIAL,
        channel: 'sms',
        status: 'sent',
        sentAt: new Date(now - 2 * DAY),
      },
    });

    // D_PAID — 8000 fully paid
    await prisma.debt.create({
      data: {
        id: D_PAID,
        businessId: BID,
        customerId: C3,
        amount: 8000,
        createdAt: new Date(now - 2 * DAY),
      },
    });
    await prisma.payment.create({
      data: {
        id: 'pay-paid-1',
        businessId: BID,
        debtId: D_PAID,
        amount: 8000,
        method: 'Bank transfer',
        reference: 'OWM-00002',
        createdAt: new Date(now - 1 * DAY),
      },
    });

    // D_SCHEDULED — 5000, due +10 days, no payment/reminder
    await prisma.debt.create({
      data: {
        id: D_SCHEDULED,
        businessId: BID,
        customerId: C4,
        amount: 5000,
        dueDate: new Date(now + 10 * DAY),
        createdAt: new Date(now - 4 * DAY),
      },
    });

    // D_ARCHIVED — soft-deleted
    await prisma.debt.create({
      data: {
        id: D_ARCHIVED,
        businessId: BID,
        customerId: C1,
        amount: 3000,
        deleted: true,
        createdAt: new Date(now - 6 * DAY),
      },
    });

    // Cross-tenant noise
    await prisma.customer.create({
      data: { id: 'other-cust-1', businessId: OTHER_BID, name: 'Zed Foreign', phone: '09999999999' },
    });
    await prisma.debt.create({
      data: { id: 'other-debt-1', businessId: OTHER_BID, customerId: 'other-cust-1', amount: 9999 },
    });

    ownerToken = mint('owner');
    staffToken = mint('staff');
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /debts with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer()).get('/debts');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('GET /debts as staff -> 200 Paginated<DebtView> with correct derivation + isolation', async () => {
    const res = await request(app.getHttpServer())
      .get('/debts')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect('nextCursor' in res.body).toBe(true);
    res.body.data.forEach((v: Record<string, unknown>) => expectDebtViewShape(v));

    // non-archived default excludes the soft-deleted row + other tenant
    expect(byId(res.body.data, D_ARCHIVED)).toBeUndefined();
    expect(byId(res.body.data, 'other-debt-1')).toBeUndefined();

    const overdue = byId(res.body.data, D_OVERDUE)!;
    expect(overdue.paidAmount).toBe(0);
    expect(overdue.remaining).toBe(10000);
    expect(overdue.status).toBe('overdue');
    expect((overdue.customer as Record<string, unknown>).id).toBe(C1);

    const partial = byId(res.body.data, D_PARTIAL)!;
    expect(partial.paidAmount).toBe(5000);
    expect(partial.remaining).toBe(15000);
    expect(partial.status).toBe('partial');

    const paid = byId(res.body.data, D_PAID)!;
    expect(paid.paidAmount).toBe(8000);
    expect(paid.remaining).toBe(0);
    expect(paid.status).toBe('paid');

    const scheduled = byId(res.body.data, D_SCHEDULED)!;
    expect(scheduled.remaining).toBe(5000);
    expect(scheduled.status).toBe('scheduled');
  });

  it('GET /debts?status=overdue -> only overdue open debts', async () => {
    const res = await request(app.getHttpServer())
      .get('/debts?status=overdue')
      .set('Authorization', `Bearer ${ownerToken}`);
    const ids = res.body.data.map((v: Record<string, unknown>) => v.id);
    expect(ids).toContain(D_OVERDUE);
    expect(ids).not.toContain(D_PARTIAL);
    expect(ids).not.toContain(D_PAID);
  });

  it('GET /debts?status=active -> open debts (remaining>0), excludes paid + archived', async () => {
    const res = await request(app.getHttpServer())
      .get('/debts?status=active')
      .set('Authorization', `Bearer ${ownerToken}`);
    const ids = res.body.data.map((v: Record<string, unknown>) => v.id);
    expect(ids).toContain(D_OVERDUE);
    expect(ids).toContain(D_PARTIAL);
    expect(ids).toContain(D_SCHEDULED);
    expect(ids).not.toContain(D_PAID);
    expect(ids).not.toContain(D_ARCHIVED);
  });

  it('GET /debts?status=paid -> only fully-paid debts', async () => {
    const res = await request(app.getHttpServer())
      .get('/debts?status=paid')
      .set('Authorization', `Bearer ${ownerToken}`);
    const ids = res.body.data.map((v: Record<string, unknown>) => v.id);
    expect(ids).toContain(D_PAID);
    expect(ids).not.toContain(D_OVERDUE);
  });

  it('GET /debts?status=archived -> only soft-deleted (deleted=true) rows', async () => {
    const res = await request(app.getHttpServer())
      .get('/debts?status=archived')
      .set('Authorization', `Bearer ${ownerToken}`);
    const ids = res.body.data.map((v: Record<string, unknown>) => v.id);
    expect(ids).toContain(D_ARCHIVED);
    expect(ids).not.toContain(D_OVERDUE);
    res.body.data.forEach((v: Record<string, unknown>) => expect(v.deleted).toBe(true));
  });

  it('GET /debts?sort=most-owed -> descending remaining', async () => {
    const res = await request(app.getHttpServer())
      .get('/debts?sort=most-owed')
      .set('Authorization', `Bearer ${ownerToken}`);
    const remaining = res.body.data.map((v: Record<string, unknown>) => v.remaining as number);
    expect(remaining).toEqual([...remaining].sort((a, b) => b - a));
    expect(res.body.data[0].id).toBe(D_PARTIAL); // 15000 largest
  });

  it('GET /debts?sort=soonest-due -> ascending dueDate (nulls last)', async () => {
    const res = await request(app.getHttpServer())
      .get('/debts?sort=soonest-due')
      .set('Authorization', `Bearer ${ownerToken}`);
    const ids = res.body.data.map((v: Record<string, unknown>) => v.id);
    // overdue (-5d) before partial (+5d) before scheduled (+10d); D_PAID (null due) last
    expect(ids.indexOf(D_OVERDUE)).toBeLessThan(ids.indexOf(D_PARTIAL));
    expect(ids.indexOf(D_PARTIAL)).toBeLessThan(ids.indexOf(D_SCHEDULED));
    expect(ids.indexOf(D_SCHEDULED)).toBeLessThan(ids.indexOf(D_PAID));
  });

  it('GET /debts?q= matches customer name / note (traditional search)', async () => {
    const res = await request(app.getHttpServer())
      .get('/debts?q=Amaka')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.body.data.map((v: Record<string, unknown>) => v.id)).toEqual([D_OVERDUE]);
  });

  it('GET /debts?limit=2 -> nextCursor paginates without overlap', async () => {
    const p1 = await request(app.getHttpServer())
      .get('/debts?sort=most-owed&limit=2')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(p1.body.data.length).toBe(2);
    expect(typeof p1.body.nextCursor).toBe('string');

    const p2 = await request(app.getHttpServer())
      .get(`/debts?sort=most-owed&limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(p2.status).toBe(200);
    const firstIds = new Set(p1.body.data.map((v: Record<string, unknown>) => v.id));
    p2.body.data.forEach((v: Record<string, unknown>) => expect(firstIds.has(v.id)).toBe(false));
  });

  it('GET /debts/:id -> 200 DebtView; unknown -> 404; cross-tenant -> 404', async () => {
    const res = await request(app.getHttpServer())
      .get(`/debts/${D_PARTIAL}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expectDebtViewShape(res.body);
    expect(res.body.remaining).toBe(15000);

    const missing = await request(app.getHttpServer())
      .get('/debts/01912ddd-0000-7000-8000-00000000dead')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');

    const foreign = await request(app.getHttpServer())
      .get('/debts/other-debt-1')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(foreign.status).toBe(404);
  });

  it('POST /debts -> 201 DebtView; re-POST same id -> 200 existing (idempotent)', async () => {
    const id = '01912ddd-0000-7000-8000-00000000aa01';
    const payload = { id, customerId: C1, amount: 12345, note: 'new sale' };

    const first = await request(app.getHttpServer())
      .post('/debts')
      .set('Authorization', `Bearer ${staffToken}`)
      .send(payload);
    expect(first.status).toBe(201);
    expectDebtViewShape(first.body);
    expect(first.body.id).toBe(id);
    expect(first.body.businessId).toBe(BID);
    expect(first.body.amount).toBe(12345);
    expect(first.body.remaining).toBe(12345);
    expect(first.body.status).toBe('outstanding');

    const again = await request(app.getHttpServer())
      .post('/debts')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ ...payload, amount: 99999 });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(id);
    expect(again.body.amount).toBe(12345); // unchanged existing row
  });

  it('POST /debts with unknown customerId -> 404/422', async () => {
    const res = await request(app.getHttpServer())
      .post('/debts')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        id: '01912ddd-0000-7000-8000-00000000aa02',
        customerId: '01912ddd-0000-7000-8000-0000000f00ff',
        amount: 5000,
      });
    expect([404, 422]).toContain(res.status);
  });

  it('POST /debts with invalid body -> 422 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .post('/debts')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ customerId: C1 }); // missing id + amount
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('PATCH /debts/:id with correct If-Match -> 200; clearDueDate nulls dueDate', async () => {
    const before = await request(app.getHttpServer())
      .get(`/debts/${D_SCHEDULED}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    const version = before.body.version as number;

    const res = await request(app.getHttpServer())
      .patch(`/debts/${D_SCHEDULED}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('If-Match', `version=${version}`)
      .send({ amount: 7000, note: 'updated', clearDueDate: true });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(7000);
    expect(res.body.note).toBe('updated');
    expect(res.body.dueDate).toBeNull();
    expect(res.body.version).toBe(version + 1);
  });

  it('PATCH /debts/:id with stale If-Match -> 409 VERSION_CONFLICT {current}', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/debts/${D_PARTIAL}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('If-Match', 'version=999')
      .send({ note: 'nope' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VERSION_CONFLICT');
    expect(res.body.current).toBeDefined();
    expect(typeof res.body.current.version).toBe('number');
  });

  it('DELETE /debts/:id as STAFF -> 403 FORBIDDEN (owner-only)', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/debts/${D_OVERDUE}`)
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    const row = await prisma.debt.findUnique({ where: { id: D_OVERDUE } });
    expect(row?.deleted).toBe(false);
  });

  it('DELETE /debts/:id as OWNER -> soft delete (deleted=true); restore -> deleted=false', async () => {
    const del = await request(app.getHttpServer())
      .delete(`/debts/${D_OVERDUE}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(del.status).toBe(200);
    expect(del.body.id).toBe(D_OVERDUE);
    expect(del.body.deleted).toBe(true);

    const restored = await request(app.getHttpServer())
      .post(`/debts/${D_OVERDUE}/restore`)
      .set('Authorization', `Bearer ${staffToken}`);
    expect(restored.status).toBe(201);
    expect(restored.body.deleted).toBe(false);
  });

  it('POST /debts/:id/pay-link -> 200/201 { url }', async () => {
    const res = await request(app.getHttpServer())
      .post(`/debts/${D_PARTIAL}/pay-link`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect([200, 201]).toContain(res.status);
    expect(typeof res.body.url).toBe('string');
    expect(res.body.url).toBe(PAY_URL);
  });

  it('GET /debts/:id/payments -> 200 Payment[] newest-first', async () => {
    const res = await request(app.getHttpServer())
      .get(`/debts/${D_PARTIAL}/payments`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    res.body.forEach((p: Record<string, unknown>) => {
      expect(typeof p.id).toBe('string');
      expect(typeof p.debtId).toBe('string');
      expect(typeof p.amount).toBe('number');
      expect(typeof p.method).toBe('string');
      expect(typeof p.reference).toBe('string');
      expect(typeof p.createdAt).toBe('string');
    });
    const times = res.body.map((p: Record<string, unknown>) => Date.parse(p.createdAt as string));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('GET /debts/:id/reminders -> 200 Reminder[]', async () => {
    const res = await request(app.getHttpServer())
      .get(`/debts/${D_PARTIAL}/reminders`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    res.body.forEach((r: Record<string, unknown>) => {
      expect(typeof r.id).toBe('string');
      expect(typeof r.debtId).toBe('string');
      expect(REMINDER_CHANNEL_VALUES).toContain(r.channel);
      expect(REMINDER_STATUS_VALUES).toContain(r.status);
      expect(r.sentAt === null || typeof r.sentAt === 'string').toBe(true);
    });
  });

  it('GET /debts/:id/reminder-schedule -> 4 offset steps when dueDate set', async () => {
    const res = await request(app.getHttpServer())
      .get(`/debts/${D_PARTIAL}/reminder-schedule`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(4);
    const labels = res.body.map((s: Record<string, unknown>) => s.offsetLabel);
    expect(labels).toEqual([
      '3 days before due',
      'On due date',
      '3 days overdue',
      'Final follow-up',
    ]);
    res.body.forEach((s: Record<string, unknown>) => {
      expect(typeof s.date).toBe('string');
      expect(['sent', 'pending']).toContain(s.status);
    });
  });

  it('GET /debts/:id/reminder-schedule -> empty when paid', async () => {
    const res = await request(app.getHttpServer())
      .get(`/debts/${D_PAID}/reminder-schedule`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
