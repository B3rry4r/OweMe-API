/**
 * Canonical string-union enums (modeled as strings end-to-end; no Prisma native enums).
 * Each union ships with a runtime const array (`*_VALUES`) for class-validator @IsIn().
 */

// Roles (S-4: coarse owner|staff)
export const ROLE_VALUES = ['owner', 'staff'] as const;
export type Role = (typeof ROLE_VALUES)[number];

// Reminder tone (S-5: third value is 'final', not 'firm')
export const REMINDER_TONE_VALUES = ['gentle', 'friendly', 'final'] as const;
export type ReminderTone = (typeof REMINDER_TONE_VALUES)[number];

// Canonical plan ids (S-3; fail-closed to 'starter')
export const PLAN_ID_VALUES = ['starter', 'market', 'business', 'enterprise'] as const;
export type PlanId = (typeof PLAN_ID_VALUES)[number];

// Debt status — DERIVED server-side, never stored
export const DEBT_STATUS_VALUES = [
  'outstanding',
  'partial',
  'overdue',
  'scheduled',
  'reminder',
  'paid',
] as const;
export type DebtStatus = (typeof DEBT_STATUS_VALUES)[number];

// Reminder channels — sms/whatsapp metered; call/manual/printable recorded-only + free
export const REMINDER_CHANNEL_VALUES = ['sms', 'whatsapp', 'call', 'manual', 'printable'] as const;
export type ReminderChannel = (typeof REMINDER_CHANNEL_VALUES)[number];

// Reminder delivery status
export const REMINDER_STATUS_VALUES = ['scheduled', 'sent', 'failed'] as const;
export type ReminderStatus = (typeof REMINDER_STATUS_VALUES)[number];

// Notification kind (code field is 'kind', default 'info')
export const NOTIFICATION_KIND_VALUES = ['payment', 'overdue', 'reminder', 'insight', 'info'] as const;
export type NotificationKind = (typeof NOTIFICATION_KIND_VALUES)[number];

// Subscription entitlement state
export const ENTITLEMENT_STATE_VALUES = [
  'none',
  'pending',
  'active',
  'gracePeriod',
  'expired',
] as const;
export type EntitlementState = (typeof ENTITLEMENT_STATE_VALUES)[number];

// Billing transaction kind
export const BILLING_KIND_VALUES = ['subscription', 'messages-bundle', 'ai-bundle'] as const;
export type BillingKind = (typeof BILLING_KIND_VALUES)[number];

// IAP platform
export const IAP_PLATFORM_VALUES = ['ios', 'android'] as const;
export type IapPlatform = (typeof IAP_PLATFORM_VALUES)[number];

// Activity item kind (derived union feed)
export const ACTIVITY_KIND_VALUES = ['payment', 'debt', 'reminder'] as const;
export type ActivityKind = (typeof ACTIVITY_KIND_VALUES)[number];

// Error envelope codes (conventions.md)
export const ERROR_CODE_VALUES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'PLAN_REQUIRED',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'RATE_LIMITED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODE_VALUES)[number];

/** HTTP status for each error code (conventions.md). */
export const ERROR_CODE_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  PLAN_REQUIRED: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};
