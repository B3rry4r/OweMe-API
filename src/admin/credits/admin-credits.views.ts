import { PlanId } from '../../shared';

/** Registry AdminCreditsView response DTOs, verbatim. */

/** Admin offset-pagination envelope per conventions: { data, page, total }. */
export interface Paged<T> {
  data: T[];
  page: number;
  total: number;
}

/** Metered event kinds carried by usage_events (append-only, populated by instrumentation). */
export type AdminBurnType = 'send' | 'voiceParse' | 'insight';

export interface AdminBurnByTypeView {
  type: AdminBurnType;
  label: string;
  /** Per-event weight from CREDIT_WEIGHTS (code truth, never hardcoded dashboard-side). */
  creditsPerEvent: number;
  events: number;
  credits: number;
}

export interface AdminCreditsStatsView {
  grantedThisMonth: number;
  burnedThisMonth: number;
  /** YYYY-MM the figures are scoped to (current calendar month, UTC). */
  monthLabel: string;
  /** Empty until usage_events is populated; the dashboard BarList renders its empty state. */
  burnByType: AdminBurnByTypeView[];
}

export interface AdminHeavyUserView {
  businessId: string;
  businessName: string;
  plan: string;
  /** Monthly grant; null when the plan is fair-use (enterprise). */
  grant: number | null;
  fairUse: boolean;
  used: number;
  bundlesThisMonth: number;
}

export interface AdminBundlePurchaseView {
  id: string;
  purchasedAt: string;
  businessName: string;
  sku: string;
  credits: number;
  /** Kobo from the bundle catalog; null when the SKU is not in the catalog. */
  priceKobo: number | null;
}

export interface AdminCreditWeightsView {
  send: number;
  voiceParse: number;
  insightOrRisk: number;
}

export interface AdminBundleSkuView {
  sku: string;
  credits: number;
  priceKobo: number;
}

export interface AdminPlanGrantView {
  planId: PlanId;
  /** null = fair-use (unmetered). */
  creditsPerMonth: number | null;
}

export interface AdminCreditsConfigView {
  bundleCapPerMonth: number;
  creditWeights: AdminCreditWeightsView;
  bundles: AdminBundleSkuView[];
  planGrants: AdminPlanGrantView[];
  fairUseNote: string;
}
