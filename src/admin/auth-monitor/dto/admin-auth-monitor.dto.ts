import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import { PAGINATION_DEFAULT_LIMIT, PAGINATION_MAX_LIMIT } from '../../../shared';
import { ADMIN_OTP_OUTCOMES, AdminOtpOutcome } from '../admin-auth-monitor.views';

/** Registry AdminAuthMonitorView query DTOs, verbatim. */

/** Longest window the daily series will render; keeps the grouping scan bounded. */
export const OTP_SERIES_MAX_DAYS = 90;
export const OTP_SERIES_DEFAULT_DAYS = 14;

export class OtpSeriesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(OTP_SERIES_MAX_DAYS)
  days?: number = OTP_SERIES_DEFAULT_DAYS;
}

export class OtpRequestsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGINATION_MAX_LIMIT)
  limit?: number = PAGINATION_DEFAULT_LIMIT;

  /** Search within the MASKED digits; full numbers are never stored to search against. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  phoneDigits?: string;

  @IsOptional()
  @IsIn(ADMIN_OTP_OUTCOMES as AdminOtpOutcome[])
  outcome?: AdminOtpOutcome;
}

export class SessionsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGINATION_MAX_LIMIT)
  limit?: number = PAGINATION_DEFAULT_LIMIT;
}
