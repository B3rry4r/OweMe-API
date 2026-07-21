/** Registry AdminPayoutsView response DTOs, verbatim. */

/** Admin offset-pagination envelope per conventions: { data, page, total }. */
export interface Paged<T> {
  data: T[];
  page: number;
  total: number;
}

export interface AdminPayoutAccountView {
  businessId: string;
  businessName: string;
  /** Resolved from bankCode via the same bank list GET /banks serves. */
  bankName: string;
  /** Masked SERVER-side: '****' + the last 4 NUBAN digits. The full number never leaves the API. */
  nubanMasked: string;
  accountName: string;
  /** Business.paystackSubaccount != null. */
  subaccountActive: boolean;
  /** Settlement is provider-side; no source exists in v1 (partial-honest-empty ruling). */
  settledMonthKobo: null;
  settledTotalKobo: null;
  pendingSettlements: null;
  lastSettlementAt: null;
}

export interface AdminPayoutStatsView {
  payoutAccountsSetUpCount: number;
  activeSubaccountCount: number;
  /** null in v1: no settlement feed exists. */
  settledToTradersMonthKobo: number | null;
  pendingSettlementsTotal: number | null;
  /** null in v1: resolve failures return 422 and are never persisted. */
  failedAccountResolutionCount: number | null;
}
