import { PlanId } from '../../shared';

/** Registry AdminBusinessesView response DTOs, verbatim. */

/** Admin offset-pagination envelope per conventions: { data, page, total }. */
export interface Paged<T> {
  data: T[];
  page: number;
  total: number;
}

/** Derived server-side: test (isTest) > suspended (suspendedAt != null) > active. */
export type AdminBusinessStatus = 'active' | 'suspended' | 'test';
export const ADMIN_BUSINESS_STATUS_VALUES: readonly AdminBusinessStatus[] = [
  'active',
  'suspended',
  'test',
];

/** Live derived debt vocabulary narrowed to the admin table's five buckets. */
export type AdminBusinessDebtStatus = 'open' | 'partial' | 'overdue' | 'paid' | 'archived';

export interface AdminBusinessView {
  id: string;
  name: string;
  ownerPhoneMasked: string;
  plan: PlanId;
  status: AdminBusinessStatus;
  isTest: boolean;
  suspendedAt: string | null;
  bvumKobo: number;
  ceilingKobo: number;
  creditsUsed: number | null;
  creditsGrant: number | null;
  staffCount: number;
  joinedAt: string;
}

export interface AdminBusinessDetailView {
  id: string;
  name: string;
  plan: PlanId;
  isTest: boolean;
  suspendedAt: string | null;
  ownerPhoneMasked: string;
  joinedAt: string;
  staffSeatsUsed: number;
  staffSeatsTotal: number;
  /** LIVE entitlement vocabulary, never the fixture's active|grace|canceled. */
  subscriptionState: 'none' | 'pending' | 'active' | 'gracePeriod' | 'expired';
  renewalAt: string | null;
  bvumKobo: number;
  baseCeilingKobo: number;
  extraBands: number;
  effectiveCeilingKobo: number;
  bundlesBoughtThisMonth: number;
  bundleCapPerMonth: number;
}

export interface AdminCreditUsageView {
  sends: number;
  parses: number;
  insights: number;
  usedCredits: number;
  grant: number | null;
  bonusCredits: number;
  fairUse: boolean;
  periodStart: string;
}

export interface AdminBusinessDebtView {
  id: string;
  /** First name only. */
  customer: string;
  amountKobo: number;
  remainingKobo: number;
  status: AdminBusinessDebtStatus;
  createdAt: string;
}
