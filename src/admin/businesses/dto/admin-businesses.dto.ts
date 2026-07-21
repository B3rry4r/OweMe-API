import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import { PAGINATION_DEFAULT_LIMIT, PAGINATION_MAX_LIMIT, PLAN_ID_VALUES, PlanId } from '../../../shared';
import { ADMIN_BUSINESS_STATUS_VALUES, AdminBusinessStatus } from '../admin-businesses.views';

/** Registry AdminBusinessesView GET /admin/businesses query, verbatim. */
export class AdminBusinessListQueryDto {
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

  /** Business name or phone contains. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  search?: string;

  @IsOptional()
  @IsIn(PLAN_ID_VALUES)
  plan?: PlanId;

  /** The dashboard's 'paused' filter maps to 'suspended' per the gap-5 ruling. */
  @IsOptional()
  @IsIn(ADMIN_BUSINESS_STATUS_VALUES)
  status?: AdminBusinessStatus;
}

/** Max page size for the per-business debt panel (registry: 1..50 default 10). */
export const ADMIN_BUSINESS_DEBTS_MAX_LIMIT = 50;
export const ADMIN_BUSINESS_DEBTS_DEFAULT_LIMIT = 10;

/** Registry AdminBusinessesView GET /admin/businesses/:id/debts query, verbatim. */
export class AdminBusinessDebtsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ADMIN_BUSINESS_DEBTS_MAX_LIMIT)
  limit?: number = ADMIN_BUSINESS_DEBTS_DEFAULT_LIMIT;
}
