/** Registry AdminPayLinksView response DTOs, verbatim. */

/** Admin offset-pagination envelope per conventions: { data, page, total }. */
export interface Paged<T> {
  data: T[];
  page: number;
  total: number;
}

export interface AdminPayLinkPaymentView {
  id: string;
  at: string;
  businessName: string;
  /** First name only: the admin surface never needs the debtor's full identity. */
  debtorFirstName: string;
  amountKobo: number;
  /** Derived at read time from src/debts/pay-link-fees.ts; never persisted. */
  combinedFeeKobo: number;
  /** Derived: OweMe's subaccount split share. */
  commissionKobo: number;
  /** Derived: combined fee minus OweMe commission. */
  processorShareKobo: number;
  /**
   * Always 'success'. The Paystack webhook records a Payment row for successful
   * charges only, so no pending or failed pay-link rows exist to show.
   */
  status: 'success';
}

export interface AdminPayLinkStatsView {
  settledCount: number;
  volumeKobo: number;
  feesChargedKobo: number;
  commissionKeptKobo: number;
  /** The month these aggregates cover (YYYY-MM), echoed back for the header. */
  month: string;
}

export type AdminWebhookSource = 'paystack' | 'iap';
export type AdminWebhookOutcome = 'ok' | 'ignored' | 'error';

export interface AdminWebhookEventView {
  id: string;
  at: string;
  source: AdminWebhookSource;
  eventType: string;
  reference: string | null;
  outcome: AdminWebhookOutcome;
  detail: object | null;
}

/** Paged webhook events plus the UNFILTERED error tally for the section subtitle. */
export interface AdminWebhookEventsView extends Paged<AdminWebhookEventView> {
  errorCount: number;
}
