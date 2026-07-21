/** Registry AdminAiUsageView response DTOs, verbatim. */

/** Admin offset-pagination envelope per conventions: { data, page, total }. */
export interface Paged<T> {
  data: T[];
  page: number;
  total: number;
}

export interface AdminAiStatsView {
  /** Fallback parses reaching the server; on-device parses never do. */
  parsesTotal: number;
  fallbackParses: number;
  /** Unknowable server-side in v1 (client heuristic), so honestly null. */
  onDeviceParses: number | null;
  onDeviceSharePct: number | null;
  /** Sum of costKoboEstimate when the instrumentation records it, else null. */
  modelSpendEstimateKobo: number | null;
  /** YYYY-MM (UTC calendar month, the credit-grant period). */
  periodMonth: string;
}

export interface AdminAiWeekPointView {
  /** ISO date (YYYY-MM-DD) of the Monday starting the week, UTC. */
  weekStart: string;
  parses: number;
}

export interface AdminAiBusinessView {
  businessId: string;
  businessName: string;
  plan: string;
  parses: number;
  /** Null in v1: the on-device share is not observable server-side. */
  onDevicePct: number | null;
  insights: number;
  creditsDebited: number;
}

export interface AdminAiParseEventView {
  id: string;
  at: string;
  businessId: string;
  businessName: string;
  /** From usage_events.meta.outcome, e.g. parsed|low-confidence|error. */
  outcome: string;
  creditsCharged: number;
}
