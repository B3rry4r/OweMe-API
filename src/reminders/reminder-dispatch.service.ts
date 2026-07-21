import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ReminderChannel } from '../shared';
import {
  MESSAGE_SENDER,
  MessageSender,
  PlanRequiredException,
  uuidv7,
} from '../common';
import { CreditLedgerService, CREDIT_WEIGHTS } from '../usage/credit-ledger.service';
import { SMS_ROUTE_COST_KOBO, UsageEventRecorder } from '../usage/usage-event.recorder';

/** Max due rows processed per tick; keeps a single tick bounded; the next tick drains the rest. */
const DISPATCH_BATCH_LIMIT = 100;

/** Recorded failure reasons (surfaced in the failure Notification body + logs). */
const REASON_INSUFFICIENT_CREDITS = 'insufficient-credits';
const REASON_UNSUPPORTED_SERVER_CHANNEL = 'unsupported-server-channel';
const REASON_DELIVERY_FAILED = 'delivery-failed';

type DueReminderRow = {
  id: string;
  businessId: string;
  debtId: string;
  channel: string;
  message: string | null;
  scheduledFor: Date | null;
  payLinkUrl: string | null;
  debt: { id: string; customer: { id: string; name: string; phone: string } };
};

/**
 * ReminderDispatchService: the scheduled-reminder delivery worker.
 *
 * A per-minute cron atomically claims due rows (status 'scheduled', scheduledFor <= now) and,
 * per row:
 *   - sms: debits CREDIT_WEIGHTS.reminderSend (5 unified OweMe credits) BEFORE dispatching via
 *     the MESSAGE_SENDER provider seam (BulkSMSNigeria / stub). Insufficient credits -> the row
 *     flips to 'failed' with reason 'insufficient-credits' and NOTHING is debited (the ledger
 *     decrement is a single atomic update, so there is no partial debit). Retryable via
 *     POST /reminders/:id/retry.
 *   - whatsapp: no server-side WhatsApp API exists, so a SCHEDULED whatsapp send fails with
 *     reason 'unsupported-server-channel' (no debit, no SMS fallback; the immediate path's
 *     fallback is a user-visible choice; a background worker must not silently switch channels).
 *   - call|manual|printable: recorded-only channels: transition to 'sent' free (no debit, no
 *     delivery contract), mirroring the immediate POST /reminders semantics.
 *
 * On every terminal transition the Reminder version bumps (+ @updatedAt) so delta sync picks it
 * up; the parent Debt gets lastReminderAt (sent only) + a recomputed nextReminderAt + a version
 * bump; and a Notification row (kind 'reminder') is written for the business's feed.
 *
 * Idempotency / crash-safety: each row is claimed with a status-transition WHERE guard
 * (updateMany WHERE status='scheduled' -> count 0 means another tick owns it), so concurrent
 * ticks or replicas can never double-debit or double-send. A crash after the claim but before
 * provider dispatch leaves the row terminal without a wire send (at-most-once delivery), never
 * a duplicate SMS or double debit.
 */
@Injectable()
export class ReminderDispatchService {
  private readonly logger = new Logger(ReminderDispatchService.name);
  /** In-process re-entrancy latch: a slow tick must not overlap the next cron fire. */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditLedgerService,
    @Inject(MESSAGE_SENDER) private readonly sender: MessageSender,
    private readonly usageEvents: UsageEventRecorder,
  ) {}

  /** Cron tick, every minute. Exposed for deterministic invocation from contract specs. */
  @Cron(CronExpression.EVERY_MINUTE)
  async dispatchDueReminders(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const due = (await this.prisma.reminder.findMany({
        where: { status: 'scheduled', scheduledFor: { lte: now } },
        include: {
          debt: {
            select: { id: true, customer: { select: { id: true, name: true, phone: true } } },
          },
        },
        orderBy: { scheduledFor: 'asc' },
        take: DISPATCH_BATCH_LIMIT,
      })) as unknown as DueReminderRow[];

      for (const row of due) {
        try {
          await this.processOne(row, now);
        } catch (err) {
          // One bad row must never stall the queue; it stays claimed in its current status.
          this.logger.error(`dispatch failed for reminder ${row.id}: ${String(err)}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  // --- per-row pipeline -------------------------------------------------------

  private async processOne(row: DueReminderRow, now: Date): Promise<void> {
    const channel = row.channel as ReminderChannel;

    if (channel === 'whatsapp') {
      // No WhatsApp server API exists; fail the row honestly instead of inventing one.
      if (!(await this.claim(row.id, { status: 'failed' }))) return;
      await this.finalizeFailed(row, now, REASON_UNSUPPORTED_SERVER_CHANNEL);
      return;
    }

    if (channel !== 'sms') {
      // call|manual|printable: recorded-only + free, matching the immediate-send semantics.
      if (!(await this.claim(row.id, { status: 'sent', sentAt: now }))) return;
      await this.finalizeSent(row, now);
      return;
    }

    // sms: claim first (the WHERE guard is the double-send lock), then debit, then dispatch.
    if (!(await this.claim(row.id, { status: 'sent', sentAt: now }))) return;

    try {
      await this.credits.debitCredits(row.businessId, CREDIT_WEIGHTS.reminderSend, 'reminder-send');
    } catch (err) {
      if (err instanceof PlanRequiredException) {
        // Out of credits: nothing was debited (single atomic decrement; no partial debit).
        await this.unclaimToFailed(row, now, REASON_INSUFFICIENT_CREDITS);
        return;
      }
      throw err;
    }

    let accepted = false;
    try {
      const result = await this.sender.send({
        phone: row.debt.customer.phone,
        message: composeMessage(row),
        channel: 'sms',
      });
      accepted = result.accepted;
    } catch (err) {
      this.logger.error(`provider send failed for reminder ${row.id}: ${String(err)}`);
    }
    if (!accepted) {
      // Debit-before-dispatch mirrors the immediate path (no refund); retry re-debits.
      await this.unclaimToFailed(row, now, REASON_DELIVERY_FAILED);
      return;
    }

    // Instrumentation (best-effort, never fails the dispatch): one usage_events row per
    // successful metered scheduled send.
    await this.usageEvents.record({
      businessId: row.businessId,
      type: 'send',
      credits: CREDIT_WEIGHTS.reminderSend,
      costKoboEstimate: SMS_ROUTE_COST_KOBO,
      meta: { reminderId: row.id, channel: 'sms', scheduled: true },
    });

    await this.finalizeSent(row, now);
  }

  /**
   * Atomic claim: transition ONLY if the row is still 'scheduled'. count 0 means a concurrent
   * tick already owns the row; the caller must skip it (never double-process).
   */
  private async claim(
    id: string,
    data: { status: 'sent'; sentAt: Date } | { status: 'failed' },
  ): Promise<boolean> {
    const res = await this.prisma.reminder.updateMany({
      where: { id, status: 'scheduled' },
      data: { ...data, version: { increment: 1 } },
    });
    return res.count === 1;
  }

  /** Flip a claimed (provisionally 'sent') row to 'failed' and record the reason. */
  private async unclaimToFailed(row: DueReminderRow, now: Date, reason: string): Promise<void> {
    await this.prisma.reminder.update({
      where: { id: row.id },
      data: { status: 'failed', sentAt: null, version: { increment: 1 } },
    });
    await this.finalizeFailed(row, now, reason);
  }

  /** Successful dispatch: stamp the debt (lastReminderAt + next schedule) and notify the feed. */
  private async finalizeSent(row: DueReminderRow, now: Date): Promise<void> {
    await this.touchDebt(row, now, { lastReminderAt: now });
    await this.createNotification(
      row.businessId,
      'Reminder sent',
      `${row.debt.customer.name} · ${row.channel}`,
    );
    this.logger.log(`reminder ${row.id} dispatched (${row.channel})`);
  }

  /** Failed dispatch: recompute the debt's next schedule and notify the feed with the reason. */
  private async finalizeFailed(row: DueReminderRow, now: Date, reason: string): Promise<void> {
    await this.touchDebt(row, now, {});
    await this.createNotification(
      row.businessId,
      'Reminder failed',
      `${row.debt.customer.name} · ${reason}`,
    );
    this.logger.warn(`reminder ${row.id} failed: ${reason}`);
  }

  /**
   * Write-through on the parent Debt: optional lastReminderAt, recomputed nextReminderAt
   * (earliest still-pending scheduled reminder), version bump (+ @updatedAt) for delta sync.
   */
  private async touchDebt(
    row: DueReminderRow,
    now: Date,
    extra: { lastReminderAt?: Date },
  ): Promise<void> {
    const pending = await this.prisma.reminder.findFirst({
      where: { debtId: row.debtId, status: 'scheduled', scheduledFor: { gt: now } },
      orderBy: { scheduledFor: 'asc' },
      select: { scheduledFor: true },
    });
    await this.prisma.debt.update({
      where: { id: row.debtId },
      data: {
        ...extra,
        nextReminderAt: pending?.scheduledFor ?? null,
        version: { increment: 1 },
      },
    });
  }

  /** Server-minted Notification row for the business's in-app feed (kind 'reminder'). */
  private async createNotification(businessId: string, title: string, body: string): Promise<void> {
    await this.prisma.notification.create({
      data: { id: uuidv7(), businessId, title, body, kind: 'reminder' },
    });
  }
}

/** Delivery body: stored message (or the standard fallback) + the debt's pay link when present. */
function composeMessage(row: DueReminderRow): string {
  const base =
    row.message ?? 'Reminder: you have an outstanding balance. Please arrange payment. Thank you.';
  if (row.payLinkUrl && !base.includes(row.payLinkUrl)) {
    return `${base}\nPay now: ${row.payLinkUrl}`;
  }
  return base;
}
