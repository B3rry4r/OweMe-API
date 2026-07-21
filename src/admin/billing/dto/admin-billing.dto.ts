import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import {
  ENTITLEMENT_STATE_VALUES,
  EntitlementState,
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
} from '../../../shared';

/** Registry AdminBillingView GET /admin/billing/subscriptions query, verbatim. */
export class AdminSubscriptionsQueryDto {
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

  /** Live entitlement vocabulary: none|pending|active|gracePeriod|expired. */
  @IsOptional()
  @IsIn(ENTITLEMENT_STATE_VALUES as readonly string[])
  state?: EntitlementState;
}

/** Registry AdminBillingView GET /admin/billing/transactions query, verbatim. */
export class AdminBillingTransactionsQueryDto {
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

  /** Business name, SKU (productId) or kind contains. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  search?: string;

  /** YYYY-MM; defaults to the current month server-side. */
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month?: string;
}

/** Registry AdminBillingView GET /admin/billing/iap-lifecycle query, verbatim. */
export class AdminIapLifecycleQueryDto {
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
