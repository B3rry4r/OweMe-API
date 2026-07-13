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
import { DashboardModule } from '../dashboard.module';
import { ACTIVITY_KIND_VALUES, Role } from '../../shared';

/**
 * Dashboard (contract). Boots a real Nest app with the SAME global guards
 * (JwtAuthGuard + RolesGuard as APP_GUARD), HttpExceptionFilter and ValidationPipe
 * as app.module. Seeds a business + owner/staff + customers + a mix of debts (overdue,
 * due today, paid, future, archived) + payments (this month) + a sent reminder + an
 * unread notification, then asserts the derived GET /dashboard shape AND aggregate values
 * (all money kobo), for BOTH owner and staff, plus the 401 no-token case.
 *
 * Expected aggregates (see seed below):
 *   outstandingTotal   = D1 100000 + D2 50000 + D3 50000 + D5 50000 = 250000
 *   owingCustomerCount = C1, C2, C3 (C2's paid debt D4 doesn't count)  = 3
 *   recoveredThisMonth = P1 30000 + P2 40000 + P3 10000               = 80000
 *   dueTodayTotal      = D2 (remaining 50000)                         = 50000
 *   overdueTotal       = D1 100000 + D3 50000                         = 150000
 *   overdueCount       = D1, D3                                        = 2
 *   activity           = 3 payments + 5 live debts + 1 sent reminder = 9 -> capped 8, at desc
 *   hasAnyDebts=true, hasAnyCustomers=true, hasUnread=true
 */
describe('Dashboard (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  const BUSINESS_ID = '01912ccc-dddd-7eee-8fff-dash000000001';
  const OTHER_BUSINESS_ID = '01912ccc-dddd-7eee-8fff-dash000000002';
  const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret';

  const mintToken = (role: Role, businessId: string | null = BUSINESS_ID): string =>
    jwt.sign({ sub: `user-${role}`, businessId, role }, { secret: JWT_SECRET, expiresIn: '1h' });

  let ownerToken: string;
  let staffToken: string;

  const C1 = '01912ccc-dddd-7eee-8fff-dashcust00001';
  const C2 = '01912ccc-dddd-7eee-8fff-dashcust00002';
  const C3 = '01912ccc-dddd-7eee-8fff-dashcust00003';

  const D1 = '01912ccc-dddd-7eee-8fff-dashdebt00001'; // C1 overdue, unpaid
  const D2 = '01912ccc-dddd-7eee-8fff-dashdebt00002'; // C1 due today, unpaid
  const D3 = '01912ccc-dddd-7eee-8fff-dashdebt00003'; // C2 overdue, partial
  const D4 = '01912ccc-dddd-7eee-8fff-dashdebt00004'; // C2 future, fully paid
  const D5 = '01912ccc-dddd-7eee-8fff-dashdebt00005'; // C3 future, partial
  const D6 = '01912ccc-dddd-7eee-8fff-dashdebt00006'; // C3 archived (excluded)

  const daysFromToday = (n: number): Date => {
    const now = new Date();
    // midday to stay inside the intended calendar day regardless of run time
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + n, 12, 0, 0);
  };
  const minsAgo = (m: number): Date => new Date(Date.now() - m * 60_000);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, DashboardModule],
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

    // Clean prior runs (children first for FK safety).
    await prisma.payment.deleteMany({ where: { businessId: { in: [BUSINESS_ID, OTHER_BUSINESS_ID] } } });
    await prisma.reminder.deleteMany({ where: { businessId: { in: [BUSINESS_ID, OTHER_BUSINESS_ID] } } });
    await prisma.debt.deleteMany({ where: { businessId: { in: [BUSINESS_ID, OTHER_BUSINESS_ID] } } });
    await prisma.notification.deleteMany({ where: { businessId: { in: [BUSINESS_ID, OTHER_BUSINESS_ID] } } });
    await prisma.customer.deleteMany({ where: { businessId: { in: [BUSINESS_ID, OTHER_BUSINESS_ID] } } });

    for (const id of [BUSINESS_ID, OTHER_BUSINESS_ID]) {
      await prisma.business.upsert({
        where: { id },
        create: {
          id,
          businessName: 'Dash Traders',
          ownerName: 'Ada Owner',
          phone: '08040000000',
          category: 'Retail',
          currency: 'NGN (₦)',
          reminderTone: 'gentle',
          plan: 'starter',
        },
        update: {},
      });
    }

    // Customers
    for (const [id, name] of [
      [C1, 'Chidi'],
      [C2, 'Bola'],
      [C3, 'Ngozi'],
    ] as const) {
      await prisma.customer.create({
        data: { id, businessId: BUSINESS_ID, name, phone: `0810000000${name.length}` },
      });
    }

    // Debts (createdAt spaced so activity order is deterministic)
    await prisma.debt.create({
      data: { id: D1, businessId: BUSINESS_ID, customerId: C1, amount: 100000, dueDate: daysFromToday(-10), createdAt: minsAgo(100), note: 'Provisions' },
    });
    await prisma.debt.create({
      data: { id: D2, businessId: BUSINESS_ID, customerId: C1, amount: 50000, dueDate: daysFromToday(0), createdAt: minsAgo(110) },
    });
    await prisma.debt.create({
      data: { id: D3, businessId: BUSINESS_ID, customerId: C2, amount: 80000, dueDate: daysFromToday(-5), createdAt: minsAgo(120) },
    });
    await prisma.debt.create({
      data: { id: D4, businessId: BUSINESS_ID, customerId: C2, amount: 40000, dueDate: daysFromToday(10), createdAt: minsAgo(130) },
    });
    await prisma.debt.create({
      data: { id: D5, businessId: BUSINESS_ID, customerId: C3, amount: 60000, dueDate: daysFromToday(10), createdAt: minsAgo(140) },
    });
    await prisma.debt.create({
      data: { id: D6, businessId: BUSINESS_ID, customerId: C3, amount: 999999, deleted: true, createdAt: minsAgo(150) },
    });

    // Payments (this month) — reduce remaining balances.
    await prisma.payment.create({
      data: { id: '01912ccc-dddd-7eee-8fff-dashpay000001', businessId: BUSINESS_ID, debtId: D3, amount: 30000, method: 'Cash', reference: 'OWM-D3', createdAt: minsAgo(5) },
    });
    await prisma.payment.create({
      data: { id: '01912ccc-dddd-7eee-8fff-dashpay000002', businessId: BUSINESS_ID, debtId: D4, amount: 40000, method: 'Bank transfer', reference: 'OWM-D4', createdAt: minsAgo(15) },
    });
    await prisma.payment.create({
      data: { id: '01912ccc-dddd-7eee-8fff-dashpay000003', businessId: BUSINESS_ID, debtId: D5, amount: 10000, method: 'POS', reference: 'OWM-D5', createdAt: minsAgo(25) },
    });

    // Reminders: R1 sent (included), R2 scheduled (excluded by status), R3 sent on archived debt (orphan, excluded).
    await prisma.reminder.create({
      data: { id: '01912ccc-dddd-7eee-8fff-dashrem000001', businessId: BUSINESS_ID, debtId: D1, channel: 'sms', status: 'sent', sentAt: minsAgo(2), createdAt: minsAgo(2) },
    });
    await prisma.reminder.create({
      data: { id: '01912ccc-dddd-7eee-8fff-dashrem000002', businessId: BUSINESS_ID, debtId: D2, channel: 'whatsapp', status: 'scheduled', createdAt: minsAgo(3) },
    });
    await prisma.reminder.create({
      data: { id: '01912ccc-dddd-7eee-8fff-dashrem000003', businessId: BUSINESS_ID, debtId: D6, channel: 'sms', status: 'sent', sentAt: minsAgo(1), createdAt: minsAgo(1) },
    });

    // One unread notification -> hasUnread true.
    await prisma.notification.create({
      data: { id: '01912ccc-dddd-7eee-8fff-dashntf000001', businessId: BUSINESS_ID, title: 'Payment received', kind: 'payment', read: false },
    });
    await prisma.notification.create({
      data: { id: '01912ccc-dddd-7eee-8fff-dashntf000002', businessId: BUSINESS_ID, title: 'Welcome', kind: 'info', read: true },
    });

    ownerToken = mintToken('owner');
    staffToken = mintToken('staff');
  });

  afterAll(async () => {
    await app.close();
  });

  const expectDashboardShape = (b: Record<string, unknown>): void => {
    expect(typeof b.outstandingTotal).toBe('number');
    expect(typeof b.owingCustomerCount).toBe('number');
    expect(typeof b.recoveredThisMonth).toBe('number');
    expect(typeof b.dueTodayTotal).toBe('number');
    expect(typeof b.overdueTotal).toBe('number');
    expect(typeof b.overdueCount).toBe('number');
    expect(typeof b.hasAnyDebts).toBe('boolean');
    expect(typeof b.hasAnyCustomers).toBe('boolean');
    expect(typeof b.hasUnread).toBe('boolean');
    expect(Array.isArray(b.activity)).toBe(true);
    (b.activity as Array<Record<string, unknown>>).forEach((a) => {
      expect(ACTIVITY_KIND_VALUES).toContain(a.kind);
      expect(typeof a.title).toBe('string');
      expect(typeof a.subtitle).toBe('string');
      expect(a.amount === null || typeof a.amount === 'number').toBe(true);
      expect(typeof a.at).toBe('string');
    });
  };

  const expectAggregates = (b: Record<string, unknown>): void => {
    expect(b.outstandingTotal).toBe(250000);
    expect(b.owingCustomerCount).toBe(3);
    expect(b.recoveredThisMonth).toBe(80000);
    expect(b.dueTodayTotal).toBe(50000);
    expect(b.overdueTotal).toBe(150000);
    expect(b.overdueCount).toBe(2);
    expect(b.hasAnyDebts).toBe(true);
    expect(b.hasAnyCustomers).toBe(true);
    expect(b.hasUnread).toBe(true);

    const activity = b.activity as Array<Record<string, unknown>>;
    // 3 payments + 5 live debts + 1 sent reminder = 9 -> capped at 8.
    expect(activity.length).toBe(8);
    // strictly non-increasing `at` (desc).
    const times = activity.map((a) => Date.parse(a.at as string));
    for (let i = 1; i < times.length; i++) {
      expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
    }
    // most recent item is the sent reminder (2 min ago).
    expect(activity[0].kind).toBe('reminder');
    // orphan reminder (on archived debt) never surfaces.
    const reminderCount = activity.filter((a) => a.kind === 'reminder').length;
    expect(reminderCount).toBe(1);
  };

  it('GET /dashboard as owner -> 200 with full shape + correct aggregates', async () => {
    const res = await request(app.getHttpServer())
      .get('/dashboard')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expectDashboardShape(res.body);
    expectAggregates(res.body);
  });

  it('GET /dashboard as staff -> 200 with full shape + correct aggregates', async () => {
    const res = await request(app.getHttpServer())
      .get('/dashboard')
      .set('Authorization', `Bearer ${staffToken}`);

    expect(res.status).toBe(200);
    expectDashboardShape(res.body);
    expectAggregates(res.body);
  });

  it('GET /dashboard with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer()).get('/dashboard');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('GET /dashboard is tenant-scoped (empty business -> zeroed summary, no cross-tenant bleed)', async () => {
    const res = await request(app.getHttpServer())
      .get('/dashboard')
      .set('Authorization', `Bearer ${mintToken('owner', OTHER_BUSINESS_ID)}`);

    expect(res.status).toBe(200);
    expectDashboardShape(res.body);
    expect(res.body.outstandingTotal).toBe(0);
    expect(res.body.owingCustomerCount).toBe(0);
    expect(res.body.recoveredThisMonth).toBe(0);
    expect(res.body.activity.length).toBe(0);
    expect(res.body.hasAnyDebts).toBe(false);
    expect(res.body.hasAnyCustomers).toBe(false);
    expect(res.body.hasUnread).toBe(false);
  });
});
