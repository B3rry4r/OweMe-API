import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { ErrorCode, ERROR_CODE_STATUS } from '../../shared';
import { AppException } from '../exceptions/app.exception';

/**
 * The ONE global error filter. Renders every thrown error as the single
 * ErrorEnvelope: { error: { code, message, details? }, ...extra }.
 *   - AppException          -> its own code/status/details/extra.
 *   - Nest ValidationPipe   -> VALIDATION_ERROR (422) with field details.
 *   - Nest HttpException     -> mapped by status.
 *   - anything else          -> INTERNAL (500).
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    let status = 500;
    let code: ErrorCode = 'INTERNAL';
    let message = 'Internal server error';
    let details: unknown[] | undefined;
    let extra: Record<string, unknown> | undefined;

    if (exception instanceof AppException) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
      extra = exception.extra;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      code = this.codeForStatus(status);
      // class-validator via ValidationPipe -> BadRequest(400) with message[]
      if (status === 400 && this.isValidationBody(body)) {
        code = 'VALIDATION_ERROR';
        status = ERROR_CODE_STATUS.VALIDATION_ERROR; // remap 400 -> 422
        details = ([] as unknown[]).concat((body as { message: unknown }).message);
        message = 'Validation failed';
      } else if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object' && 'message' in body) {
        const m = (body as { message: unknown }).message;
        message = Array.isArray(m) ? m.join(', ') : String(m);
      } else {
        message = exception.message;
      }
    } else {
      this.logger.error(
        exception instanceof Error ? exception.stack ?? exception.message : String(exception),
      );
    }

    const payload: Record<string, unknown> = {
      error: { code, message, ...(details ? { details } : {}) },
      ...(extra ?? {}),
    };
    // requiredPlan belongs INSIDE error (per conventions PLAN_REQUIRED shape).
    if (extra && 'requiredPlan' in extra) {
      (payload.error as Record<string, unknown>).requiredPlan = extra.requiredPlan;
      delete (payload as Record<string, unknown>).requiredPlan;
    }

    res.status(status).json(payload);
  }

  private isValidationBody(body: unknown): body is { message: unknown[] } {
    return (
      !!body &&
      typeof body === 'object' &&
      'message' in body &&
      Array.isArray((body as { message: unknown }).message)
    );
  }

  private codeForStatus(status: number): ErrorCode {
    switch (status) {
      case 401:
        return 'UNAUTHENTICATED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 409:
        return 'VERSION_CONFLICT';
      case 422:
        return 'VALIDATION_ERROR';
      case 429:
        return 'RATE_LIMITED';
      default:
        return status >= 500 ? 'INTERNAL' : 'VALIDATION_ERROR';
    }
  }
}
