import { HttpException } from '@nestjs/common';
import { ErrorCode, ERROR_CODE_STATUS } from '../../shared';

/**
 * Base typed exception. Build agents throw these (or the named subclasses / Nest's
 * built-in HttpExceptions); they NEVER hand-roll the error JSON. The global
 * HttpExceptionFilter renders the single ErrorEnvelope from this.
 *
 * `extra` is merged at the TOP LEVEL of the response body (alongside `error`) — used
 * for `current` (VERSION_CONFLICT) and `requiredPlan` (PLAN_REQUIRED, nested under error).
 */
export class AppException extends HttpException {
  readonly code: ErrorCode;
  readonly details?: unknown[];
  readonly extra?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: { details?: unknown[]; extra?: Record<string, unknown> },
  ) {
    super(message, ERROR_CODE_STATUS[code]);
    this.code = code;
    this.details = opts?.details;
    this.extra = opts?.extra;
  }
}

export class ValidationException extends AppException {
  constructor(message = 'Validation failed', details?: unknown[]) {
    super('VALIDATION_ERROR', message, { details });
  }
}

export class UnauthenticatedException extends AppException {
  constructor(message = 'Authentication required') {
    super('UNAUTHENTICATED', message);
  }
}

export class ForbiddenAppException extends AppException {
  constructor(message = 'Forbidden') {
    super('FORBIDDEN', message);
  }
}

/** 403 with `error.requiredPlan` so the app can show an upgrade prompt. */
export class PlanRequiredException extends AppException {
  constructor(requiredPlan: string, message = 'Upgrade required for this capability') {
    super('PLAN_REQUIRED', message, { extra: { requiredPlan } });
  }
}

export class NotFoundAppException extends AppException {
  constructor(message = 'Not found') {
    super('NOT_FOUND', message);
  }
}

/** 409 with the current server row so the offline client can re-apply (LWW per field-set). */
export class VersionConflictException extends AppException {
  constructor(current: unknown, message = 'Version conflict') {
    super('VERSION_CONFLICT', message, { extra: { current } });
  }
}

export class RateLimitedException extends AppException {
  constructor(message = 'Too many requests') {
    super('RATE_LIMITED', message);
  }
}
