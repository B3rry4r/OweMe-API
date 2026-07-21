/** Registry AdminOverview response DTOs, verbatim. */

/** Tone vocabulary the dashboard Badge renders (registry AdminPlatformEventView.tone). */
export type AdminPlatformEventTone = 'brand' | 'gold' | 'neutral' | 'danger' | 'info';

export interface AdminOverviewPlanCounts {
  starter: number;
  market: number;
  business: number;
  wholesale: number;
  enterprise: number;
}

export interface AdminOverviewView {
  registeredBusinesses: number;
  activePaidSubscriptions: number;
  /** Flat plan component only; the enterprise band premium is priced display-side. */
  mrrKobo: number;
  /** Sum of Business.enterpriseBands; band price math stays on the client. */
  enterpriseBandsTotal: number;
  creditsBurnedThisMonth: number;
  recoveredThisMonthKobo: number;
  commissionThisMonthKobo: number;
  /** 12 entries, oldest first. */
  weeklyRecoveredKobo: number[];
  planCounts: AdminOverviewPlanCounts;
}

export interface AdminPlatformEventView {
  /** Synthetic, source-prefixed row id (no platform_event table exists). */
  id: string;
  business: string;
  event: string;
  tone: AdminPlatformEventTone;
  at: string;
}
