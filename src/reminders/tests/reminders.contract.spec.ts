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
import { MESSAGE_SENDER } from '../../common/providers/tokens';
import { UsageModule } from '../../usage/usage.module';
import { CREDIT_WEIGHTS } from '../../usage/credit-ledger.service';
import { RemindersModule } from '../reminders.module';
import { REMINDER_CHANNEL_VALUES, REMINDER_STATUS_VALUES, Role } from '../../shared';

/**
 * Reminder (contract). Boots a real Nest app with the SAME global guards (JwtAuthGuard +
 * RolesGuard), HttpExceptionFilter and ValidationPipe as app.module. Imports UsageModule for
 * the exported CreditLedgerService (rev 2 unified "OweMe credits" metering) and overrides
 * MESSAGE_SENDER with a spy stub.
 *
 * Seeds a starter-plan tenant (unified credit ledger) + owner/staff + a customer + a debt, and
 * asserts: immediate sends of ANY channel -> 201 recorded free (manual deeplink sends are
 * never metered or blocked); scheduled rows -> metered later by the delivery worker; GET
 * status filter + debt/customer join + cursor pagination; retry of a failed sms row -> 200
 * sent + 5 credits debited; whatsapp retry -> 422. Asserts SHAPES + metering, never snapshots.
 */
describe('Reminder (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const sendSpy = jest.fn(async () => ({ providerMessageId: 'spy-1', accepted: true }));

  const BID = '01912ddd-aaaa-7eee-8fff-remd000000001';
  const OTHER_BID = '01912ddd-aaaa-7eee-8fff-remd000000999';
  const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret';

  const mint = (role: Role, businessId: string | null = BID): string =>
    jwt.sign({ sub: `user-${role}`, businessId, role }, { secret: JWT_SECRET, expiresIn: '1h' });

  let ownerToken: string;
  let staffToken: string;

  const CUST = '01912ddd-0000-7000-8000-remd0000000c1';
  const DEBT = '01912ddd-0000-7000-8000-remd00000d001';

  // Pre-seeded reminder rows for GET filtering + retry.
  const R_SENT = '01912ddd-0000-7000-8000-remd0000se001';
  const R_SCHEDULED = '01912ddd-0000-7000-8000-remd0000sc001';
  const R_FAILED = '01912ddd-0000-7000-8000-remd0000fa001';

  const MONTH_START = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
  );
  const DAY = 24 * 60 * 60 * 1000;

  // rev 2: metering runs off the ONE unified "OweMe credits" ledger and applies only to
  // SERVER dispatches (scheduled worker, sms retry). Immediate creates record manual sends
  // and are always free. Seed/deplete the unified creditLedger directly in these tests.
  const CREDITS_PER_SEND = CREDIT_WEIGHTS.reminderSend; // 5

  const setCredits = (balance: number): Promise<unknown> =>
    prisma.creditLedger.upsert({
      where: { businessId: BID },
      create: { businessId: BID, balance, monthlyGrant: 50, periodStart: MONTH_START },
      update: { balance, monthlyGrant: 50, periodStart: MONTH_START },
    });

  const creditBalanceNow = async (): Promise<number> => {
    const l = await prisma.creditLedger.findUnique({ where: { businessId: BID } });
    return l!.balance;
  };

  const expectReminderShape = (r: Record<string, unknown>): void => {
    expect(typeof r.id).toBe('string');
    expect(typeof r.businessId).toBe('string');
    expect(typeof r.debtId).toBe('string');
    expect(REMINDER_CHANNEL_VALUES).toContain(r.channel);
    expect(REMINDER_STATUS_VALUES).toContain(r.status);
    expect(r.message === null || typeof r.message === 'string').toBe(true);
    expect(r.scheduledFor === null || typeof r.scheduledFor === 'string').toBe(true);
    expect(r.sentAt === null || typeof r.sentAt === 'string').toBe(true);
    expect(r.payLinkUrl === null || typeof r.payLinkUrl === 'string').toBe(true);
    expect(typeof r.createdAt).toBe('string');
    expect(typeof r.updatedAt).toBe('string');
    expect(typeof r.version).toBe('number');
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, UsageModule, RemindersModule],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideProvider(MESSAGE_SENDER)
      .useValue({ send: sendSpy })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
    await app.init();

    // Clean any prior rows for these tenants.
    for (const b of [BID, OTHER_BID]) {
      await prisma.reminder.deleteMany({ where: { businessId: b } });
      await prisma.debt.deleteMany({ where: { businessId: b } });
      await prisma.customer.deleteMany({ where: { businessId: b } });
      await prisma.creditLedger.deleteMany({ where: { businessId: b } });
    }

    for (const [id, name] of [
      [BID, 'Reminder Traders'],
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
          plan: 'starter',
        },
        update: { plan: 'starter' },
      });
    }

    await prisma.customer.create({
      data: { id: CUST, businessId: BID, name: 'Amaka Debtor', phone: '08111111111' },
    });
    await prisma.debt.create({
      data: { id: DEBT, businessId: BID, customerId: CUST, amount: 50000 },
    });

    // Pre-seeded reminder history for GET filtering + retry.
    await prisma.reminder.create({
      data: {
        id: R_SENT,
        businessId: BID,
        debtId: DEBT,
        channel: 'sms',
        status: 'sent',
        sentAt: new Date(Date.now() - 2 * DAY),
      },
    });
    await prisma.reminder.create({
      data: {
        id: R_SCHEDULED,
        businessId: BID,
        debtId: DEBT,
        channel: 'whatsapp',
        status: 'scheduled',
        scheduledFor: new Date(Date.now() + 3 * DAY),
      },
    });
    await prisma.reminder.create({
      data: {
        id: R_FAILED,
        businessId: BID,
        debtId: DEBT,
        channel: 'sms',
        status: 'failed',
        message: 'Please pay',
      },
    });

    // Starter grant = 50 credits (10 metered sends); ample for the immediate sends below.
    await setCredits(50);

    ownerToken = mint('owner');
    staffToken = mint('staff');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => sendSpy.mockClear());

  it('POST /reminders with no token -> 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer())
      .post('/reminders')
      .send({ id: 'x', debtId: DEBT, channel: 'sms' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('POST /reminders channel=sms (immediate) -> 201 recorded FREE; no debit, no server dispatch', async () => {
    // Rev 2 canon: an immediate create RECORDS a deeplink send the trader already made
    // from their own phone. Free and unmetered; server dispatch happens only via the
    // scheduled worker and retry.
    const before = await creditBalanceNow();
    const id = '01912ddd-0000-7000-8000-remd00post001';
    const res = await request(app.getHttpServer())
      .post('/reminders')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ id, debtId: DEBT, channel: 'sms', message: 'Kindly settle up' });
    expect(res.status).toBe(201);
    expectReminderShape(res.body);
    expect(res.body.id).toBe(id);
    expect(res.body.businessId).toBe(BID);
    expect(res.body.channel).toBe('sms');
    expect(res.body.status).toBe('sent');
    expect(typeof res.body.sentAt).toBe('string');

    expect(await creditBalanceNow()).toBe(before); // manual deeplink sends are free
    expect(sendSpy).not.toHaveBeenCalled(); // the trader's phone sent it, not the server
  });

  it('POST /reminders channel=manual/call/printable -> 201 recorded free; no dispatch', async () => {
    for (const channel of ['manual', 'call', 'printable'] as const) {
      const before = await creditBalanceNow();
      const id = `01912ddd-0000-7000-8000-remd000free${channel.slice(0, 2)}`;
      const res = await request(app.getHttpServer())
        .post('/reminders')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ id, debtId: DEBT, channel });
      expect(res.status).toBe(201);
      expect(res.body.channel).toBe(channel);
      expect(res.body.status).toBe('sent');
      expect(await creditBalanceNow()).toBe(before); // free — unmetered
    }
    expect(sendSpy).not.toHaveBeenCalled(); // no delivery contract for free channels
  });

  it('POST /reminders idempotent on id -> 200 existing (no double debit)', async () => {
    const id = '01912ddd-0000-7000-8000-remd00idem001';
    const first = await request(app.getHttpServer())
      .post('/reminders')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ id, debtId: DEBT, channel: 'sms' });
    expect(first.status).toBe(201);
    const afterFirst = await creditBalanceNow();

    const again = await request(app.getHttpServer())
      .post('/reminders')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ id, debtId: DEBT, channel: 'sms' });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(id);
    expect(await creditBalanceNow()).toBe(afterFirst); // not debited again
  });

  it('POST /reminders future scheduledFor -> 201 scheduled; not metered/sent', async () => {
    const before = await creditBalanceNow();
    const id = '01912ddd-0000-7000-8000-remd00sched01';
    const res = await request(app.getHttpServer())
      .post('/reminders')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        id,
        debtId: DEBT,
        channel: 'sms',
        scheduledFor: new Date(Date.now() + 5 * DAY).toISOString(),
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('scheduled');
    expect(res.body.sentAt).toBeNull();
    expect(await creditBalanceNow()).toBe(before); // future send not yet metered
  });

  it('POST /reminders invalid channel -> 422 VALIDATION_ERROR', async () => {
    const res = await request(app.getHttpServer())
      .post('/reminders')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ id: '01912ddd-0000-7000-8000-remd00bad0001', debtId: DEBT, channel: 'email' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /reminders sms with zero credits -> still 201 recorded (manual sends never blocked)', async () => {
    await setCredits(0);
    const id = '01912ddd-0000-7000-8000-remd00exha001';
    const res = await request(app.getHttpServer())
      .post('/reminders')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ id, debtId: DEBT, channel: 'sms' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('sent');
    expect(await creditBalanceNow()).toBe(0); // still free at zero balance
    await setCredits(50);
  });

  it('GET /reminders?status=sent -> 200 Paginated with debt+customer joined; only sent', async () => {
    const res = await request(app.getHttpServer())
      .get('/reminders?status=sent')
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect('nextCursor' in res.body).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    res.body.data.forEach((r: Record<string, unknown>) => {
      expectReminderShape(r);
      expect(r.status).toBe('sent');
      const debt = r.debt as Record<string, unknown>;
      expect(typeof debt.id).toBe('string');
      expect(typeof debt.amount).toBe('number');
      const cust = r.customer as Record<string, unknown>;
      expect(typeof cust.id).toBe('string');
      expect(typeof cust.name).toBe('string');
      expect(typeof cust.phone).toBe('string');
    });
    const ids = res.body.data.map((r: Record<string, unknown>) => r.id);
    expect(ids).toContain(R_SENT);
    expect(ids).not.toContain(R_SCHEDULED);
    expect(ids).not.toContain(R_FAILED);
  });

  it('GET /reminders?status=scheduled -> only scheduled rows', async () => {
    const res = await request(app.getHttpServer())
      .get('/reminders?status=scheduled')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((r: Record<string, unknown>) => r.id);
    expect(ids).toContain(R_SCHEDULED);
    expect(ids).not.toContain(R_SENT);
    res.body.data.forEach((r: Record<string, unknown>) => expect(r.status).toBe('scheduled'));
  });

  it('GET /reminders?limit=1 -> nextCursor paginates without overlap', async () => {
    const p1 = await request(app.getHttpServer())
      .get('/reminders?limit=1')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(p1.status).toBe(200);
    expect(p1.body.data.length).toBe(1);
    expect(typeof p1.body.nextCursor).toBe('string');

    const p2 = await request(app.getHttpServer())
      .get(`/reminders?limit=1&cursor=${encodeURIComponent(p1.body.nextCursor)}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(p2.status).toBe(200);
    expect(p1.body.data[0].id).not.toBe(p2.body.data[0].id);
  });

  it('GET /reminders is tenant-scoped (never leaks other businesses)', async () => {
    const res = await request(app.getHttpServer())
      .get('/reminders')
      .set('Authorization', `Bearer ${ownerToken}`);
    res.body.data.forEach((r: Record<string, unknown>) => expect(r.businessId).toBe(BID));
  });

  it('POST /reminders/:id/retry on a FAILED row -> 200 sent; re-metered', async () => {
    await setCredits(50);
    const before = await creditBalanceNow();
    const res = await request(app.getHttpServer())
      .post(`/reminders/${R_FAILED}/retry`)
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(200);
    expectReminderShape(res.body);
    expect(res.body.id).toBe(R_FAILED);
    expect(res.body.status).toBe('sent');
    expect(typeof res.body.sentAt).toBe('string');
    expect(await creditBalanceNow()).toBe(before - CREDITS_PER_SEND); // re-debited (5 credits) for the sms retry
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('POST /reminders/:id/retry on a non-failed row -> 422', async () => {
    const res = await request(app.getHttpServer())
      .post(`/reminders/${R_SENT}/retry`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /reminders/:id/retry on a failed WHATSAPP row -> 422 (no server WhatsApp API)', async () => {
    const id = '01912ddd-0000-7000-8000-remdwafail001';
    await prisma.reminder.create({
      data: {
        id,
        businessId: BID,
        debtId: DEBT,
        channel: 'whatsapp',
        status: 'failed',
      },
    });
    const before = await creditBalanceNow();
    const res = await request(app.getHttpServer())
      .post(`/reminders/${id}/retry`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await creditBalanceNow()).toBe(before); // no debit on the refused retry
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
