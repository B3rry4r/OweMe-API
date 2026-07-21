import type { Paged } from '../audit/admin-audit.views';

/** Registry AdminAuthMonitorView response DTOs, verbatim. */

export type { Paged };

/** Outcome vocabulary of otp_request_log (registry newTables.otp_request_log). */
export type AdminOtpOutcome =
  | 'requested'
  | 'delivered-unknown'
  | 'verified'
  | 'failed'
  | 'rate-limited';

export const ADMIN_OTP_OUTCOMES: readonly AdminOtpOutcome[] = [
  'requested',
  'delivered-unknown',
  'verified',
  'failed',
  'rate-limited',
];

export interface AdminOtpStatsView {
  otpRequestsToday: number;
  /** null while the provider reports no delivery receipts (BulkSMSNigeria reports nothing back). */
  deliverySuccessPct: number | null;
  failedVerificationsToday: number;
  rateLimitBlocksToday: number;
}

export interface AdminOtpSeriesView {
  /** ISO date (YYYY-MM-DD), UTC. */
  startDate: string;
  /** ISO date (YYYY-MM-DD), UTC. */
  endDate: string;
  /** One count per day in [startDate, endDate], oldest first. */
  counts: number[];
}

export interface AdminOtpRequestView {
  id: string;
  requestedAt: string;
  /** Phones are stored and served MASKED; full numbers never enter the log. */
  phoneMasked: string;
  outcome: AdminOtpOutcome;
  attempts: number;
  /** Derived: outcome === 'rate-limited'. */
  rateLimited: boolean;
}

export interface AdminTestNumberView {
  businessId: string;
  businessName: string;
  /** Full phone: test-flagged businesses only, superadmin only. Codes are never shipped here. */
  phone: string;
  hasActiveCode: boolean;
  expiresAt: string | null;
}

export interface AdminRevocationView {
  staffId: string;
  businessName: string | null;
  revokedAt: string;
  expiresAt: string;
  /** Rotations in the rotatedFrom chain behind this token. */
  chainDepth: number;
  /** null until the optional RefreshToken.revokedReason instrumentation lands. */
  reason: string | null;
}

export interface AdminSessionSecurityView {
  activeSessionCount: number;
  revokedLast7d: number;
  /** null until revokedReason instrumentation. */
  reuseIncidentsLast7d: number | null;
  /** null until revokedReason instrumentation. */
  logoutRevocationsLast7d: number | null;
  recentRevocations: Paged<AdminRevocationView>;
}
