import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { CommonModule } from '../../common/common.module';
import { MESSAGE_SENDER } from '../../common/providers/tokens';
import { MessageSender, SendMessageInput } from '../../common/providers/message-sender';
import { UsageModule } from '../../usage/usage.module';
import { CreditLedgerService, CREDIT_WEIGHTS } from '../../usage/credit-ledger.service';
import { RemindersModule } from '../reminders.module';
import { ReminderDispatchService } from '../reminder-dispatch.service';

/**
 * Reminder delivery worker (contract). Boots the real RemindersModule stack (real Prisma/SQLite,
 * real CreditLedgerService) with MESSAGE_SENDER overridden by a spy stub, and drives
 * ReminderDispatchService.dispatchDueReminders() directly (the cron trigger is just transport).
 *
 * Asserts the worker contract:
 *   - a due 'scheduled' sms row is claimed and dispatched end to end: status sent + sentAt,
 *     5-credit debit, pay link embedded in the wire message, Debt.lastReminderAt written,
 *     nextReminderAt recomputed, version/updatedAt bumped on BOTH rows (delta-sync visibility),
 *     and a kind 'reminder' Notification row created;
 *   - future scheduledFor rows are skipped untouched;
 *   - insufficient credits -> status failed, NO partial debit, failure Notification with reason;
 *   - scheduled whatsapp -> failed with reason unsupported-server-channel (no debit, no send);
 *   - free channels (call) transition to sent without metering or provider dispatch;
 *   - two concurrent worker instances never double-process one row (status-transition claim).
 */
describe('Reminder delivery worker (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let credits: CreditLedgerService;
  let worker: ReminderDispatchService;
  const sendSpy = jest.fn(async (_input: SendMessageInput) => ({
    providerMessageId: 'spy-1',
    accepted: true,
  }));

  const BID = '01912ddd-aaaa-7eee-8fff-disp00000001';
  const CUST = '01912ddd-0000-7000-8000-disp0000c001';
  const DEBT = '01912ddd-0000-7000-8000-disp0000d001';

  const MONTH_START = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const MIN = 60 * 1000;
  const DAY = 24 * 60 * MIN;
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

  const seedScheduled = (
    id: string,
    opts: {
      channel?: string;
      scheduledFor: Date;
      message?: string | null;
      payLinkUrl?: string | null;
    },
  ): Promise<unknown> =>
    prisma.reminder.create({
      data: {
        id,
        businessId: BID,
        debtId: DEBT,
        channel: opts.channel ?? 'sms',
        status: 'scheduled',
        message: opts.message ?? null,
        scheduledFor: opts.scheduledFor,
        payLinkUrl: opts.payLinkUrl ?? null,
      },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, CommonModule, UsageModule, RemindersModule],
    })
      .overrideProvider(MESSAGE_SENDER)
      .useValue({ send: sendSpy })
      .compile();

    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    credits = app.get(CreditLedgerService);
    worker = app.get(ReminderDispatchService);
    await app.init();

    await prisma.notification.deleteMany({ where: { businessId: BID } });
    await prisma.reminder.deleteMany({ where: { businessId: BID } });
    await prisma.debt.deleteMany({ where: { businessId: BID } });
    await prisma.customer.deleteMany({ where: { businessId: BID } });
    await prisma.creditLedger.deleteMany({ where: { businessId: BID } });

    await prisma.business.upsert({
      where: { id: BID },
      create: {
        id: BID,
        businessName: 'Dispatch Traders',
        ownerName: 'Owner',
        phone: '08030000000',
        category: 'Retail',
        currency: 'NGN (₦)',
        reminderTone: 'gentle',
        plan: 'starter',
      },
      update: { plan: 'starter' },
    });
    await prisma.customer.create({
      data: { id: CUST, businessId: BID, name: 'Amaka Debtor', phone: '08111111111' },
    });
    await prisma.debt.create({
      data: { id: DEBT, businessId: BID, customerId: CUST, amount: 50000 },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    sendSpy.mockClear();
    sendSpy.mockImplementation(async () => ({ providerMessageId: 'spy-1', accepted: true }));
    await prisma.notification.deleteMany({ where: { businessId: BID } });
    await prisma.reminder.deleteMany({ where: { businessId: BID } });
    await setCredits(50);
  });

  it('dispatches a due sms reminder end to end: sent + debit + pay link + debt stamps + notification + sync bumps', async () => {
    const R_DUE = '01912ddd-0000-7000-8000-disp0000r001';
    const R_NEXT = '01912ddd-0000-7000-8000-disp0000r002';
    const nextAt = new Date(Date.now() + 3 * DAY);
    await seedScheduled(R_DUE, {
      scheduledFor: new Date(Date.now() - 2 * MIN),
      message: 'Kindly settle up',
      payLinkUrl: 'https://paystack.test/pay/disp0000d001',
    });
    await seedScheduled(R_NEXT, { scheduledFor: nextAt }); // stays pending; drives nextReminderAt

    const reminderBefore = (await prisma.reminder.findUnique({ where: { id: R_DUE } }))!;
    const debtBefore = (await prisma.debt.findUnique({ where: { id: DEBT } }))!;
    const balanceBefore = await creditBalanceNow();

    await worker.dispatchDueReminders();

    // Reminder transitioned scheduled -> sent, version/updatedAt bumped for delta sync.
    const reminderAfter = (await prisma.reminder.findUnique({ where: { id: R_DUE } }))!;
    expect(reminderAfter.status).toBe('sent');
    expect(reminderAfter.sentAt).not.toBeNull();
    expect(reminderAfter.version).toBe(reminderBefore.version + 1);
    expect(reminderAfter.updatedAt.getTime()).toBeGreaterThanOrEqual(
      reminderBefore.updatedAt.getTime(),
    );

    // Exactly one metered debit (5 credits).
    expect(await creditBalanceNow()).toBe(balanceBefore - CREDITS_PER_SEND);

    // Dispatched once via the MESSAGE_SENDER seam, pay link embedded in the wire message.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const wire = sendSpy.mock.calls[0][0];
    expect(wire.channel).toBe('sms');
    expect(wire.phone).toBe('08111111111');
    expect(wire.message).toContain('Kindly settle up');
    expect(wire.message).toContain('Pay now: https://paystack.test/pay/disp0000d001');

    // Debt stamped: lastReminderAt written, nextReminderAt recomputed to the pending row,
    // version/updatedAt bumped for delta sync.
    const debtAfter = (await prisma.debt.findUnique({ where: { id: DEBT } }))!;
    expect(debtAfter.lastReminderAt).not.toBeNull();
    expect(debtAfter.nextReminderAt?.getTime()).toBe(nextAt.getTime());
    expect(debtAfter.version).toBe(debtBefore.version + 1);
    expect(debtAfter.updatedAt.getTime()).toBeGreaterThanOrEqual(debtBefore.updatedAt.getTime());

    // Notification row for the business's feed.
    const note = await prisma.notification.findFirst({
      where: { businessId: BID, title: 'Reminder sent' },
    });
    expect(note).not.toBeNull();
    expect(note!.kind).toBe('reminder');
    expect(note!.body).toContain('Amaka Debtor');
    expect(note!.read).toBe(false);
  });

  it('skips future scheduled reminders untouched (no send, no debit, no transition)', async () => {
    const R_FUTURE = '01912ddd-0000-7000-8000-disp0000r010';
    await seedScheduled(R_FUTURE, { scheduledFor: new Date(Date.now() + 2 * DAY) });
    const balanceBefore = await creditBalanceNow();

    await worker.dispatchDueReminders();

    const row = (await prisma.reminder.findUnique({ where: { id: R_FUTURE } }))!;
    expect(row.status).toBe('scheduled');
    expect(row.sentAt).toBeNull();
    expect(row.version).toBe(0);
    expect(await creditBalanceNow()).toBe(balanceBefore);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('fails cleanly on insufficient credits: status failed, NO partial debit, reason recorded', async () => {
    const R_BROKE = '01912ddd-0000-7000-8000-disp0000r020';
    await seedScheduled(R_BROKE, { scheduledFor: new Date(Date.now() - MIN) });
    await setCredits(CREDITS_PER_SEND - 1); // 4 < 5: cannot afford one send

    await worker.dispatchDueReminders();

    const row = (await prisma.reminder.findUnique({ where: { id: R_BROKE } }))!;
    expect(row.status).toBe('failed');
    expect(row.sentAt).toBeNull();
    expect(row.version).toBeGreaterThanOrEqual(1); // bumped so delta sync surfaces the failure
    expect(await creditBalanceNow()).toBe(CREDITS_PER_SEND - 1); // untouched: no partial debit
    expect(sendSpy).not.toHaveBeenCalled();

    const note = await prisma.notification.findFirst({
      where: { businessId: BID, title: 'Reminder failed' },
    });
    expect(note).not.toBeNull();
    expect(note!.kind).toBe('reminder');
    expect(note!.body).toContain('insufficient-credits');

    // The debt is bumped too (nextReminderAt recomputed to null: nothing pending anymore).
    const debt = (await prisma.debt.findUnique({ where: { id: DEBT } }))!;
    expect(debt.nextReminderAt).toBeNull();
  });

  it('fails a scheduled whatsapp send with reason unsupported-server-channel (no debit, no dispatch)', async () => {
    const R_WA = '01912ddd-0000-7000-8000-disp0000r030';
    await seedScheduled(R_WA, { channel: 'whatsapp', scheduledFor: new Date(Date.now() - MIN) });
    const balanceBefore = await creditBalanceNow();

    await worker.dispatchDueReminders();

    const row = (await prisma.reminder.findUnique({ where: { id: R_WA } }))!;
    expect(row.status).toBe('failed');
    expect(row.sentAt).toBeNull();
    expect(await creditBalanceNow()).toBe(balanceBefore);
    expect(sendSpy).not.toHaveBeenCalled();

    const note = await prisma.notification.findFirst({
      where: { businessId: BID, title: 'Reminder failed' },
    });
    expect(note!.body).toContain('unsupported-server-channel');
  });

  it('transitions a due free-channel (call) reminder to sent without metering or dispatch', async () => {
    const R_CALL = '01912ddd-0000-7000-8000-disp0000r040';
    await seedScheduled(R_CALL, { channel: 'call', scheduledFor: new Date(Date.now() - MIN) });
    const balanceBefore = await creditBalanceNow();

    await worker.dispatchDueReminders();

    const row = (await prisma.reminder.findUnique({ where: { id: R_CALL } }))!;
    expect(row.status).toBe('sent');
    expect(row.sentAt).not.toBeNull();
    expect(await creditBalanceNow()).toBe(balanceBefore); // free channel: unmetered
    expect(sendSpy).not.toHaveBeenCalled(); // no delivery contract

    const debt = (await prisma.debt.findUnique({ where: { id: DEBT } }))!;
    expect(debt.lastReminderAt).not.toBeNull();
  });

  it('never double-processes one row under concurrent workers (status-transition claim guard)', async () => {
    const R_RACE = '01912ddd-0000-7000-8000-disp0000r050';
    await seedScheduled(R_RACE, { scheduledFor: new Date(Date.now() - MIN) });
    const balanceBefore = await creditBalanceNow();

    // A second instance simulates a second replica/tick: separate in-process latch, same DB.
    const workerB = new ReminderDispatchService(prisma, credits, {
      send: sendSpy,
    } as MessageSender);
    await Promise.all([worker.dispatchDueReminders(), workerB.dispatchDueReminders()]);
    await worker.dispatchDueReminders(); // and a follow-up tick: the row is terminal, not re-claimed

    const row = (await prisma.reminder.findUnique({ where: { id: R_RACE } }))!;
    expect(row.status).toBe('sent');
    expect(sendSpy).toHaveBeenCalledTimes(1); // exactly one wire send
    expect(await creditBalanceNow()).toBe(balanceBefore - CREDITS_PER_SEND); // exactly one debit
    const notes = await prisma.notification.findMany({
      where: { businessId: BID, title: 'Reminder sent' },
    });
    expect(notes.length).toBe(1); // exactly one feed entry
  });

  it('flips the claimed row to failed when the provider rejects the send (delivery-failed reason)', async () => {
    const R_REJ = '01912ddd-0000-7000-8000-disp0000r060';
    await seedScheduled(R_REJ, { scheduledFor: new Date(Date.now() - MIN) });
    sendSpy.mockImplementationOnce(async () => ({ providerMessageId: '', accepted: false }));

    await worker.dispatchDueReminders();

    const row = (await prisma.reminder.findUnique({ where: { id: R_REJ } }))!;
    expect(row.status).toBe('failed'); // retryable via POST /reminders/:id/retry
    expect(row.sentAt).toBeNull();
    const note = await prisma.notification.findFirst({
      where: { businessId: BID, title: 'Reminder failed' },
    });
    expect(note!.body).toContain('delivery-failed');
  });
});
