import { ReminderChannel, ReminderStatus } from '../../shared';

/** Registry AdminRemindersView response DTOs, verbatim. */

/** Admin offset-pagination envelope per conventions: { data, page, total }. */
export interface Paged<T> {
  data: T[];
  page: number;
  total: number;
}

export interface AdminReminderStatsView {
  sendsThisMonth: number;
  /**
   * Always null in v1: BulkSMSNigeria dispatch is fire-and-forget with no delivery
   * receipts (protected registry), so the card ships honest-empty rather than
   * inventing a number.
   */
  deliveredThisMonth: number | null;
  smsSendsThisMonth: number;
  /** Null while no priced usage_events rows exist for the month. */
  smsCostThisMonthKobo: number | null;
  /** Served from CREDIT_WEIGHTS, never hardcoded on the wire. */
  creditsPerSend: number;
  /** Current calendar month, YYYY-MM (UTC). */
  month: string;
}

export interface AdminReminderView {
  id: string;
  businessName: string;
  channel: ReminderChannel;
  /** Schedule steps are derived on the fly, never stored: null in v1. */
  step: number | null;
  scheduledFor: string | null;
  sentAt: string | null;
  status: ReminderStatus;
  /** Joins usage_events via meta.reminderId once instrumented; null meanwhile. */
  costKoboEstimate: number | null;
}

export interface AdminSmsCostPointView {
  /** Monday of the bucket, ISO date (YYYY-MM-DD, UTC). */
  weekStart: string;
  /** Null for weeks with no priced send rows (the sparkline's honest empty state). */
  costPerSmsAvgKobo: number | null;
}
