/** Registry AdminSyncHealthView response DTOs, verbatim. */

/** Admin offset-pagination envelope per conventions: { data, page, total }. */
export interface Paged<T> {
  data: T[];
  page: number;
  total: number;
}

export interface AdminSyncTotalsView {
  /** Customer rows carrying deleted=true (they surface to clients as sync tombstones). */
  customerTombstones: number;
  /** Debt rows carrying deleted=true (same rows as archivedDebts: one column serves both). */
  debtTombstones: number;
  /** Debt rows carrying deleted=true, read as the app's status=archived listing. */
  archivedDebts: number;
}

export interface AdminSyncBusinessView {
  businessId: string;
  businessName: string;
  customerTombstones: number;
  debtTombstones: number;
  /**
   * Max updatedAt across the synced entities this view reads (Customer, Debt, Payment),
   * ISO-8601. A RECENCY PROXY only: no per-device sync cursor is stored server-side, so
   * this is the newest server-side write, not the newest device pull. null when the
   * business has never written a synced row.
   */
  newestWriteAt: string | null;
}

export interface AdminSyncHealthView {
  totals: AdminSyncTotalsView;
  /** Support-facing plain-English statements of the v1 sync gaps, surfaced verbatim. */
  knownLimitations: string[];
  perBusiness: Paged<AdminSyncBusinessView>;
}
