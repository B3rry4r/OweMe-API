import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import {
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
  PLAN_ID_VALUES,
  PlanId,
} from '../../../shared';

/** Heaviest-users table page size (registry: 1..50, default 10). */
export const HEAVY_USERS_DEFAULT_LIMIT = 10;
export const HEAVY_USERS_MAX_LIMIT = 50;

/** Registry AdminCreditsView GET /admin/credits/heavy-users query, verbatim. */
export class HeavyUsersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(HEAVY_USERS_MAX_LIMIT)
  limit?: number = HEAVY_USERS_DEFAULT_LIMIT;

  @IsOptional()
  @IsIn(PLAN_ID_VALUES)
  plan?: PlanId;
}

/** Registry AdminCreditsView GET /admin/credits/bundle-purchases query, verbatim. */
export class BundlePurchasesQueryDto {
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

  /** YYYY-MM; defaults to the current calendar month. */
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month?: string;
}
