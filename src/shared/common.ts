/** Shared wire shapes used across every module. */
import { ErrorCode } from './enums';

/** Cursor-paginated envelope (?cursor&limit; default 20, max 100). */
export interface Paginated<T> {
  data: T[];
  nextCursor: string | null;
}

/** The single API error shape (produced only by the global HttpExceptionFilter). */
export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown[];
  };
}

/** 409 body for a stale optimistic-concurrency write (If-Match version mismatch). */
export interface VersionConflictEnvelope<T = unknown> extends ErrorEnvelope {
  current: T;
}

/** 403 body when a capability is gated by plan. */
export interface PlanRequiredEnvelope extends ErrorEnvelope {
  error: ErrorEnvelope['error'] & { requiredPlan?: string };
}

export const PAGINATION_DEFAULT_LIMIT = 20;
export const PAGINATION_MAX_LIMIT = 100;

/** JWT access-token claims / request-scoped auth principal. */
export interface AuthUser {
  userId: string; // JWT sub
  businessId: string | null;
  role: import('./enums').Role;
}
