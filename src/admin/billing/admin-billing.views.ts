import { BillingKind, EntitlementState } from '../../shared';

/** Registry AdminBillingView response DTOs, verbatim. */

/** Admin offset-pagination envelope per conventions: { data, page, total }. */
export interface Paged<T> {
  data: T[];
  page: number;
  total: number;
}

export interface AdminSubscriptionView {
  businessId: string;
  businessName: string;
  /** Subscription.activePlanId (the entitled plan, not the requested one). */
  plan: string;
  /** Plan.pricePerMonth for the active plan; 0 when the plan is free or unknown. */
  priceKobo: number;
  /**
   * Always null in v1: the store platform is observed at verify time and never
   * persisted, so there is nothing honest to report. The dashboard renders the
   * source filter disabled until a source field is ruled in.
   */
  source: null;
  /** Subscription.renewalAt. */
  currentPeriodEnd: string | null;
  state: EntitlementState;
}

export interface AdminBillingTransactionView {
  id: string;
  at: string;
  businessName: string;
  kind: BillingKind;
  /** BillingTransaction.productId. */
  sku: string;
  /** Recorded amount in kobo; may be 0 on webhook-recorded bundle rows. */
  grossKobo: number;
  /** List price from bundle-catalog.ts / Plan.pricePerMonth; null when the SKU is unknown. */
  catalogPriceKobo: number | null;
  /** Always null: no store-fee derivation has been ruled (followUp billing-fee-derivation). */
  storeFeeKobo: null;
  /** Always null for the same reason; never an invented percentage of gross. */
  netKobo: null;
}

export interface AdminBillingStatsView {
  activeSubscriptionCount: number;
  graceSubscriptionCount: number;
  /** Flat plan component only; enterprise band premium stays display-side. */
  mrrKobo: number;
  /** Always null pending the fee-derivation followUp. */
  storeFeeMonthKobo: null;
  /** Always null until the iap webhook instrumentation lands (expired-this-month transitions). */
  failedRenewalsThisMonth: null;
}

export interface AdminEntitlementStateCounts {
  none: number;
  pending: number;
  active: number;
  gracePeriod: number;
  expired: number;
}

export interface AdminIapEventView {
  id: string;
  at: string;
  eventType: string;
  /** Resolved from the event detail when it carries a businessId; null otherwise. */
  businessName: string | null;
  outcome: 'ok' | 'ignored' | 'error';
  detail: object | null;
}

export interface AdminIapLifecycleView {
  entitlementStateCounts: AdminEntitlementStateCounts;
  events: Paged<AdminIapEventView>;
}
