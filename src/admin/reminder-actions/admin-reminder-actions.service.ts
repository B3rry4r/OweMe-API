import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotFoundAppException } from '../../common';
import { Reminder, ReminderChannel, ReminderStatus } from '../../shared';
import { CREDIT_WEIGHTS } from '../../usage/credit-ledger.service';
import { RemindersService } from '../../reminders/reminders.service';
import { AdminPrincipal } from '../common';
import { AdminAuditService } from '../audit/admin-audit.service';
import { AdminReminderView } from './admin-reminder-actions.views';

/** The one channel the server can dispatch, and therefore the only one that meters. */
const METERED_CHANNEL: ReminderChannel = 'sms';

/**
 * Reminder support actions for the admin surface (registry AdminReminderActions).
 *
 * The retry itself is the LIVE RemindersService.retry - the exact code path the app's
 * POST /reminders/:id/retry runs, injected here rather than reimplemented, so the admin
 * button can never drift from trader-facing behaviour (failed rows only, whatsapp refused,
 * sms re-debits 5 unified credits then re-dispatches through MESSAGE_SENDER, exhausted
 * credits -> 403 PLAN_REQUIRED with the row left failed). RemindersModule does not export
 * the provider, so the class is registered by this module; it holds no state, so the second
 * instance is behaviourally identical to the app's.
 *
 * The only admin-specific part is tenancy: there is no JWT businessId on the admin surface,
 * so the row is resolved by id ACROSS tenants and the live retry is then invoked inside that
 * reminder's OWN business. Every completed retry is audit-logged with the real side effects
 * (credits debited, SMS dispatched), never a generic sentence.
 */
@Injectable()
export class AdminReminderActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reminders: RemindersService,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * POST /admin/reminders/:id/retry - cross-tenant re-dispatch of a FAILED reminder.
   *
   * Re-run safety comes from the live status machine, not from a second one: the first call
   * moves the row to 'sent', so an immediate repeat hits the 'only failed rows' refusal and
   * returns 422 without a second debit, a second SMS or a second audit row. Refusals change
   * nothing and are therefore not audit-logged (mirroring the other admin write modules).
   */
  async retry(actor: AdminPrincipal, id: string): Promise<AdminReminderView> {
    // Cross-tenant resolution: by id only, with no businessId filter (DECLARED EXCEPTION).
    const before = await this.prisma.reminder.findUnique({ where: { id } });
    if (!before) throw new NotFoundAppException('Reminder not found');

    const business = await this.prisma.business.findUnique({
      where: { id: before.businessId },
      select: { businessName: true },
    });

    // Act INSIDE the reminder's own tenant. Throws 422 / 403 exactly as the app does, in
    // which case nothing below runs and the row stays failed.
    const updated = await this.reminders.retry(before.businessId, id);

    const channel = before.channel as ReminderChannel;
    const metered = channel === METERED_CHANNEL;
    const creditsDebited = metered ? CREDIT_WEIGHTS.reminderSend : 0;

    await this.audit.record(actor, {
      actionType: 'retry-reminder',
      action:
        `${actor.name} retried a failed ${channel} reminder for ` +
        `${business?.businessName ?? before.businessId}`,
      targetType: 'Reminder',
      targetId: id,
      targetBusinessId: before.businessId,
      before: {
        status: before.status,
        sentAt: before.sentAt ? before.sentAt.toISOString() : null,
        version: before.version,
      },
      after: {
        status: updated.status,
        sentAt: updated.sentAt,
        version: updated.version,
        creditsDebited,
        smsDispatched: metered,
      },
      note: metered
        ? `Re-dispatched a real SMS and debited ${creditsDebited} OweMe credits from the business`
        : 'Marked sent with no server dispatch and no credit debit (unmetered channel)',
    });

    return this.toView(updated, business?.businessName ?? '');
  }

  // --- internals -----------------------------------------------------------

  /** Same projection the wave-2 monitor list serves, so the row the dashboard patches matches. */
  private toView(row: Reminder, businessName: string): AdminReminderView {
    return {
      id: row.id,
      businessName,
      channel: row.channel as ReminderChannel,
      // Schedule steps are derived on the fly by the app, never stored.
      step: null,
      scheduledFor: row.scheduledFor,
      sentAt: row.sentAt,
      status: row.status as ReminderStatus,
      // usage_events carry no meta.reminderId yet; null until that instrumentation lands.
      costKoboEstimate: null,
    };
  }
}
