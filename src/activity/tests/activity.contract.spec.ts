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
import { ActivityModule } from '../activity.module';
import { ACTIVITY_KIND_VALUES, Role } from '../../shared';

/**
 * Activity (contract). Boots a real Nest app with the SAME global guards (JwtAuthGuard +
 * RolesGuard), HttpExceptionFilter and ValidationPipe as app.module. Seeds a tenant + a
 * customer + debts + payments + a sent reminder (plus cross-tenant noise, a soft-deleted
 * debt with a payment/reminder, and an unsent reminder), then asserts the derived
 * Paginated<ActivityItem> feed: payment/debt/reminder kinds with correct title/subtitle/
 * amount (kobo, null for reminder), `at` desc ordering, cursor pagination, tenant isolation,
 * exclusion of items whose parent debt is gone, and 401 without a token.
 * Asserts SHAPES + ordering — never snapshots.
 */
describe('Activity (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const BID = '01912ddd-aaaa-7eee-8fff-acti000000001';
  const OTHER_BID = '01912ddd-aaaa-7eee-8fff-acti000000999';
  const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret';

  const mint = (role: Role, businessId: string | null = BID): string =>
    jwt.sign({ sub: `user-${role}`, businessId, role }, { secret: JWT_SECRET, expiresIn: '1h' });

  let ownerToken: string;

  const CUST = '01912ddd-0000-7000-8000-00000000ac01';
  const CUST_NAME = 'Amaka Trader';

  const D_LIVE = '01912ddd-0000-7000-8000-0000000ad001'; // non-deleted, note 'engine parts'
  const D_GONE = '01912ddd-0000-7000-8000-0000000ad002'; // soft-deleted

  const DAY = 24 * 60 * 60 * 1000;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, ActivityModule],
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
      await prisma.reminder.deleteMany({ where: { businessId: b } });
      await prisma.payment.deleteMany({ where: { businessId: b } });
      await prisma.debt.deleteMany({ where: { businessId: b } });
      await prisma.customer.deleteMany({ where: { businessId: b } });
    }

    for (const [id, name] of [
      [BID, 'Activity Traders'],
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

    await prisma.customer.create({
      data: { id: CUST, businessId: BID, name: CUST_NAME, phone: '08111111111' },
    });

    // Live debt (t-10d) + its payment (t-2d) + its sent reminder (t-1d)
    await prisma.debt.create({
      data: {
        id: D_LIVE,
        businessId: BID,
        customerId: CUST,
        amount: 10000,
        note: 'engine parts',
        createdAt: new Date(now - 10 * DAY),
      },
    });
    await prisma.payment.create({
      data: {
        id: 'act-pay-1',
        businessId: BID,
        debtId: D_LIVE,
        amount: 4000,
        method: 'Cash',
        reference: 'OWM-90001',
        createdAt: new Date(now - 2 * DAY),
      },
    });
    await prisma.reminder.create({
      data: {
        id: 'act-rem-sent-1',
        businessId: BID,
        debtId: D_LIVE,
        channel: 'sms',
        status: 'sent',
        sentAt: new Date(now - 1 * DAY),
      },
    });
    // Unsent reminder on the live debt -> must NOT appear
    await prisma.reminder.create({
      data: {
        id: 'act-rem-unsent-1',
        businessId: BID,
        debtId: D_LIVE,
        channel: 'sms',
        status: 'scheduled',
        scheduledFor: new Date(now + 1 * DAY),
      },
    });

    // Soft-deleted debt + a payment + a sent reminder on it -> all THREE must be excluded
    await prisma.debt.create({
      data: {
        id: D_GONE,
        businessId: BID,
        customerId: CUST,
        amount: 5000,
        deleted: true,
        createdAt: new Date(now - 3 * DAY),
      },
    });
    await prisma.payment.create({
      data: {
        id: 'act-pay-gone',
        businessId: BID,
        debtId: D_GONE,
        amount: 5000,
        method: 'Cash',
        reference: 'OWM-90002',
        createdAt: new Date(now - 0.5 * DAY), // most-recent by time, but excluded
      },
    });
    await prisma.reminder.create({
      data: {
        id: 'act-rem-gone',
        businessId: BID,
        debtId: D_GONE,
        channel: 'whatsapp',
        status: 'sent',
        sentAt: new Date(now - 0.4 * DAY),
      },
    });

    // Cross-tenant noise -> must never appear
    await prisma.customer.create({
      data: { id: 'act-other-cust', businessId: OTHER_BID, name: 'Zed Foreign', phone: '09999999999' },
    });
    await prisma.debt.create({
      data: {
        id: 'act-other-debt',
        businessId: OTHER_BID,
        customerId: 'act-other-cust',
        amount: 9999,
        createdAt: new Date(now),
      },
    });
    await prisma.payment.create({
      data: {
        id: 'act-other-pay',
        businessId: OTHER_BID,
        debtId: 'act-other-debt',
        amount: 9999,
        method: 'Cash',
        reference: 'OWM-90003',
        createdAt: new Date(now),
      },
    });

    ownerToken = mint('owner');
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  const expectActivityShape = (v: Record<string, unknown>): void => {
    expect(ACTIVITY_KIND_VALUES).toContain(v.kind);
    expect(typeof v.title).toBe('string');
    expect(typeof v.subtitle).toBe('string');
    expect(v.amount === null || typeof v.amount === 'number').toBe(true);
    expect(typeof v.at).toBe('string');
    expect(Number.isNaN(Date.parse(v.at as string))).toBe(false);
  };

  it('GET /activity with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer()).get('/activity');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('GET /activity -> 200 Paginated<ActivityItem> with payment/debt/reminder kinds, correct fields, at desc', async () => {
    const res = await request(app.getHttpServer())
      .get('/activity')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect('nextCursor' in res.body).toBe(true);
    res.body.data.forEach((v: Record<string, unknown>) => expectActivityShape(v));

    const items = res.body.data as Array<Record<string, unknown>>;

    // Exactly the three live-debt-derived items (debt + payment + sent reminder).
    expect(items.length).toBe(3);
    const kinds = items.map((v) => v.kind);
    expect(kinds).toContain('payment');
    expect(kinds).toContain('debt');
    expect(kinds).toContain('reminder');

    const debt = items.find((v) => v.kind === 'debt')!;
    expect(debt.title).toBe('Debt added');
    expect(debt.subtitle).toBe(`${CUST_NAME} · engine parts`); // customer.name + ' · ' + note
    expect(debt.amount).toBe(10000); // kobo

    const payment = items.find((v) => v.kind === 'payment')!;
    expect(payment.title).toBe('Payment received');
    expect(payment.subtitle).toBe(CUST_NAME);
    expect(payment.amount).toBe(4000); // kobo

    const reminder = items.find((v) => v.kind === 'reminder')!;
    expect(reminder.title).toBe('Reminder sent');
    expect(reminder.subtitle).toBe(`${CUST_NAME} · sms`); // customer.name + ' · ' + channel
    expect(reminder.amount).toBeNull(); // reminders carry no amount

    // Ordering: `at` strictly descending across the merged feed.
    const times = items.map((v) => Date.parse(v.at as string));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // reminder (t-1d) newest, then payment (t-2d), then debt (t-10d)
    expect(items[0].kind).toBe('reminder');
    expect(items[1].kind).toBe('payment');
    expect(items[2].kind).toBe('debt');
  });

  it('GET /activity excludes items whose parent debt is gone + other tenants', async () => {
    const res = await request(app.getHttpServer())
      .get('/activity')
      .set('Authorization', `Bearer ${ownerToken}`);
    const items = res.body.data as Array<Record<string, unknown>>;
    // The soft-deleted debt's payment/reminder are the most-recent by time but must be absent.
    // With only the 3 live items present, no item's amount is 5000 (the gone debt/payment) or 9999.
    const amounts = items.map((v) => v.amount);
    expect(amounts).not.toContain(5000);
    expect(amounts).not.toContain(9999);
    // whatsapp reminder belonged to the gone debt -> excluded
    expect(items.find((v) => v.subtitle === `${CUST_NAME} · whatsapp`)).toBeUndefined();
  });

  it('GET /activity?limit=2 -> nextCursor paginates the merged feed without overlap', async () => {
    const p1 = await request(app.getHttpServer())
      .get('/activity?limit=2')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(p1.status).toBe(200);
    expect(p1.body.data.length).toBe(2);
    expect(typeof p1.body.nextCursor).toBe('string');

    const p2 = await request(app.getHttpServer())
      .get(`/activity?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(p2.status).toBe(200);
    expect(p2.body.data.length).toBe(1); // 3 total -> 2 + 1
    expect(p2.body.nextCursor).toBeNull();

    // Continuity: page1 tail `at` >= page2 head `at` (global desc order preserved).
    const p1Last = Date.parse(p1.body.data[p1.body.data.length - 1].at);
    const p2First = Date.parse(p2.body.data[0].at);
    expect(p1Last).toBeGreaterThanOrEqual(p2First);
  });
});
