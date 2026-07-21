import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, WebhookEventLog } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotFoundAppException, ValidationException, uuidv7 } from '../../common';
import { WebhookAck, WebhooksService } from '../../webhooks/webhooks.service';
import { AdminPrincipal } from '../common';
import { AdminAuditService } from '../audit/admin-audit.service';
import {
  AdminWebhookEventView,
  AdminWebhookOutcome,
  AdminWebhookSource,
  WebhookReplayEnvelope,
} from './admin-webhook-actions.views';

/** Only a delivery that FAILED may be re-delivered; every other outcome is refused. */
const REPLAYABLE_OUTCOME = 'error';

/** Sources the live WebhooksService can process; anything else has no processing path. */
const REPLAYABLE_SOURCES: readonly string[] = ['paystack', 'iap'];

/** The live handler signatures own the payload shapes; we borrow them instead of restating. */
type PaystackPayload = Parameters<WebhooksService['handlePaystack']>[1];
type IapPayload = Parameters<WebhooksService['handleIap']>[0];

/**
 * Webhook replay (registry AdminWebhookActions), superadmin + support per the conventions
 * role matrix. The ONE write on this surface, and it is audit-logged.
 *
 * Replay is a RE-DELIVERY, not a reimplementation: the stored payload goes back through the
 * very same WebhooksService methods a live provider call reaches, so the reconciliation
 * rules (charge-recording invariant, archived/overpayment notifications, server-side IAP
 * tenant binding, fail-closed expiry) stay in exactly one place. Consequences:
 *   - Idempotency is inherited, not re-added. Paystack is idempotent on data.reference and
 *     IAP on the store transaction id, so a replay of work that already landed records no
 *     second Payment and grants no second credit; it acks processed:false and the row is
 *     logged 'ignored'. Re-running is therefore always safe.
 *   - The Paystack HMAC is still verified on every replay. This module does not bypass the
 *     trust boundary; it hands back the signature captured with the payload.
 *
 * Log bookkeeping per replay (both, deliberately):
 *   - APPENDS a fresh webhook_event_log row carrying the new outcome (registry: the appended
 *     row is what the endpoint returns), so the original failure is never erased.
 *   - UPDATES the original row's outcome to what the replay actually produced, so the error
 *     counter and the 'error' filter stop reporting a failure that has since been resolved.
 *     A resolved row is no longer replayable, which is what makes a double-click harmless.
 *
 * Writes webhook_event_log + admin_audit_log directly; every other table it touches is
 * touched BY the live webhook code, never by this module.
 */
@Injectable()
export class AdminWebhookActionsService {
  private readonly logger = new Logger(AdminWebhookActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhooksService,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * POST /admin/webhooks/events/:id/replay - re-deliver one error-outcome event.
   * 404 when the id is unknown (the table is legitimately EMPTY until the capture-time
   * instrumentation lands, so every id is unknown then). 422 when the row is not an error
   * row, when it retains nothing replayable, or when the re-delivery itself fails.
   */
  async replay(actor: AdminPrincipal, id: string): Promise<AdminWebhookEventView> {
    const row = await this.prisma.webhookEventLog.findUnique({ where: { id } });
    if (!row) throw new NotFoundAppException('Webhook event not found');
    if (row.outcome !== REPLAYABLE_OUTCOME) {
      throw new ValidationException(
        `Only error-outcome webhook events can be replayed; this event is '${row.outcome}'`,
      );
    }
    // Everything refusable is refused BEFORE any write, so a rejected replay leaves no trace.
    const envelope = this.replayEnvelope(row);

    let ack: WebhookAck;
    try {
      ack = await this.dispatch(row, envelope);
    } catch (error) {
      return this.recordFailure(actor, row, envelope, error);
    }

    const outcome: AdminWebhookOutcome = ack.processed ? 'ok' : 'ignored';
    const appended = await this.prisma.webhookEventLog.create({
      data: {
        id: uuidv7(),
        source: row.source,
        eventType: row.eventType,
        reference: row.reference,
        outcome,
        detail: {
          replayOfId: row.id,
          replayedByAdminId: actor.adminId,
          processed: ack.processed,
          ...(envelope.businessId === null ? {} : { businessId: envelope.businessId }),
        },
      },
    });
    await this.prisma.webhookEventLog.update({ where: { id: row.id }, data: { outcome } });

    await this.audit.record(actor, {
      actionType: 'replay-webhook',
      action: `${actor.name} replayed ${row.source} webhook event ${this.label(row)}`,
      targetType: 'WebhookEventLog',
      targetId: row.id,
      ...(envelope.businessId === null ? {} : { targetBusinessId: envelope.businessId }),
      before: { outcome: row.outcome },
      after: { outcome, processed: ack.processed, replayEventId: appended.id },
      ...(ack.processed
        ? {}
        : { note: 'Already reconciled: the replay was a no-op, so nothing was applied twice' }),
    });
    return this.toView(appended);
  }

  // --- internals -----------------------------------------------------------

  /** Re-enter the live handler for this source. Paystack re-verifies the retained signature. */
  private dispatch(row: WebhookEventLog, envelope: WebhookReplayEnvelope): Promise<WebhookAck> {
    if (row.source === 'iap') {
      return this.webhooks.handleIap(envelope.payload as IapPayload);
    }
    const raw = Buffer.from(envelope.rawBody ?? JSON.stringify(envelope.payload));
    return this.webhooks.handlePaystack(
      raw,
      envelope.payload as PaystackPayload,
      envelope.signature ?? undefined,
    );
  }

  /**
   * The re-delivery threw (an unverifiable retained signature, an unverifiable receipt, a
   * transient provider/db failure). We log the fresh failure - carrying the ORIGINAL detail
   * forward so the appended row stays replayable once the cause is fixed - leave the source
   * row 'error', audit the attempt truthfully, and refuse.
   */
  private async recordFailure(
    actor: AdminPrincipal,
    row: WebhookEventLog,
    envelope: WebhookReplayEnvelope,
    error: unknown,
  ): Promise<never> {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Replay of webhook event '${row.id}' failed: ${message}`);

    const carried = (row.detail ?? {}) as Prisma.InputJsonObject;
    const appended = await this.prisma.webhookEventLog.create({
      data: {
        id: uuidv7(),
        source: row.source,
        eventType: row.eventType,
        reference: row.reference,
        outcome: 'error',
        detail: {
          ...carried,
          replayOfId: row.id,
          replayedByAdminId: actor.adminId,
          processed: false,
          error: message,
        },
      },
    });

    await this.audit.record(actor, {
      actionType: 'replay-webhook',
      action: `${actor.name} replayed ${row.source} webhook event ${this.label(row)}`,
      targetType: 'WebhookEventLog',
      targetId: row.id,
      ...(envelope.businessId === null ? {} : { targetBusinessId: envelope.businessId }),
      before: { outcome: row.outcome },
      after: { outcome: 'error', processed: false, replayEventId: appended.id, error: message },
      note: 'Replay failed; the event stays in error and can be replayed again',
    });
    throw new ValidationException(`Replay failed: ${message}`);
  }

  /**
   * Read the retained delivery off the row, refusing anything that cannot be re-delivered
   * honestly. See WebhookReplayEnvelope for the detail contract.
   */
  private replayEnvelope(row: WebhookEventLog): WebhookReplayEnvelope {
    if (!REPLAYABLE_SOURCES.includes(row.source)) {
      throw new ValidationException(
        `Webhook source '${row.source}' has no processing path to replay`,
      );
    }
    const detail = this.asObject(row.detail);
    if (detail === null) {
      throw new ValidationException(
        'This webhook event retains no payload, so it cannot be replayed',
      );
    }
    // `payload` is the contract key; `body` is the alias the capture instrumentation uses.
    const nested = this.asObject(detail.payload) ?? this.asObject(detail.body);
    const payload = nested ?? detail;
    const signature = this.asString(detail.signature);

    if (row.source === 'paystack' && signature === null) {
      throw new ValidationException(
        'This Paystack event retains no provider signature, so it cannot be replayed',
      );
    }
    return {
      payload,
      rawBody: this.asString(detail.rawBody),
      signature,
      businessId: this.asString(detail.businessId),
    };
  }

  /** Human label for the audit sentence: the reference when there is one, else the id. */
  private label(row: WebhookEventLog): string {
    return row.reference === null ? `${row.eventType} (${row.id})` : `${row.eventType} (${row.reference})`;
  }

  private asObject(value: unknown): Record<string, unknown> | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  private asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  private toView(row: WebhookEventLog): AdminWebhookEventView {
    return {
      id: row.id,
      at: row.createdAt.toISOString(),
      source: row.source as AdminWebhookSource,
      eventType: row.eventType,
      reference: row.reference,
      outcome: row.outcome as AdminWebhookOutcome,
      detail: row.detail === null ? null : (row.detail as object),
    };
  }
}
