import type { WebhookEventLog } from '@prisma/client';

/**
 * The replay action returns the SAME row shape the webhook log table already renders
 * (registry AdminWebhookActions declares no DTOs of its own), so the view type is
 * reused from AdminPayLinksView rather than restated here - one shape, no drift.
 */
export type {
  AdminWebhookEventView,
  AdminWebhookOutcome,
  AdminWebhookSource,
} from '../pay-links/admin-pay-links.views';

/**
 * Replay contract for `webhook_event_log.detail` on OUTCOME 'error' rows.
 *
 * The capture-time instrumentation (registry instr-9 / instr-10, PROTECTED path) retains
 * the verified delivery on error rows so support can replay it. This module reads it and
 * NOTHING else; it never reconstructs a payload it was not given:
 *
 *   payload   the provider payload exactly as parsed at capture time. `body` is accepted
 *             as an alias (the instrumentation names the retained payload that way). When
 *             neither key is present the whole `detail` object is treated as the payload,
 *             so a flat instrumentation shape also replays; extra keys are ignored by the
 *             processing path, which reads only the provider fields it knows.
 *   rawBody   paystack only: the exact bytes the signature was computed over. Absent,
 *             we fall back to a canonical re-serialization of `payload`, which is the
 *             same fallback the live WebhooksController uses when req.rawBody is gone.
 *   signature paystack only: the x-paystack-signature header of the original delivery.
 *             REQUIRED - the live handler verifies the HMAC on every call and this
 *             module deliberately does not bypass that trust boundary, so a paystack
 *             error row captured without its signature refuses the replay (422)
 *             instead of being processed unverified.
 *   businessId optional attribution the IAP feed already reads from detail; carried
 *             over onto the appended replay row and onto the audit entry.
 */
export interface WebhookReplayEnvelope {
  payload: Record<string, unknown>;
  rawBody: string | null;
  signature: string | null;
  businessId: string | null;
}

/** Detail written onto the log row the replay APPENDS (registry: the replay outcome row). */
export interface WebhookReplayDetail {
  /** webhook_event_log.id of the error row this replay re-delivered. */
  replayOfId: string;
  replayedByAdminId: string;
  /** WebhookAck.processed of the replay: false when the work was already done. */
  processed: boolean;
  businessId?: string;
  error?: string;
}

/** Rows this module writes are ordinary log rows; alias kept for readable signatures. */
export type WebhookEventLogRow = WebhookEventLog;
