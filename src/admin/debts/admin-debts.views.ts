/** Registry AdminDebtsView response DTOs, verbatim. */

/** Admin offset-pagination envelope per conventions: { data, page, total }. */
export interface Paged<T> {
  data: T[];
  page: number;
  total: number;
}

/**
 * Admin debt status vocabulary. Derived from the LIVE derivation (never stored):
 * archived <- Debt.deleted, paid <- remaining <= 0, overdue <- due date passed,
 * partial <- some payment recorded; the live outstanding/reminder/scheduled
 * severities all collapse to 'open' for the admin table.
 */
export const ADMIN_DEBT_STATUS_VALUES = [
  'open',
  'partial',
  'overdue',
  'paid',
  'archived',
] as const;
export type AdminDebtStatus = (typeof ADMIN_DEBT_STATUS_VALUES)[number];

export interface AdminDebtView {
  id: string;
  businessName: string;
  /** Customer identity minimised server-side: first name token only. */
  customerFirstName: string;
  /** All digits masked except the last 4, e.g. '*********0001'. */
  customerPhoneMasked: string;
  amountKobo: number;
  remainingKobo: number;
  dueDate: string | null;
  status: AdminDebtStatus;
  remindersSent: number;
  /** Whole days from debt creation to the settling payment; null while unpaid. */
  daysToRecovery: number | null;
}

export interface AdminDebtStatsView {
  openRemainingKobo: number;
  recoveredThisMonthKobo: number;
  overdueDebtCount: number;
  avgDaysToRecovery: number | null;
}

export interface AdminPaymentView {
  id: string;
  businessName: string;
  amountKobo: number;
  /** Served VERBATIM as stored; the dashboard labels client-side. */
  method: string;
  paidAt: string;
}
