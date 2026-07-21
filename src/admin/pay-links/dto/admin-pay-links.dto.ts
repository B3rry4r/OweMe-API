import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { PAGINATION_DEFAULT_LIMIT, PAGINATION_MAX_LIMIT } from '../../../shared';
import { AdminWebhookOutcome, AdminWebhookSource } from '../admin-pay-links.views';

/** Registry AdminPayLinksView GET /admin/pay-links/payments query, verbatim. */
export class PayLinkPaymentsQueryDto {
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

  /** Defaults to the current UTC month in the service, never a hardcoded prefix. */
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month?: string;
}

/** Registry AdminPayLinksView GET /admin/pay-links/stats query, verbatim. */
export class PayLinkStatsQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month?: string;
}

/** Registry AdminPayLinksView GET /admin/webhooks/events query, verbatim. */
export class WebhookEventsQueryDto {
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

  @IsOptional()
  @IsIn(['paystack', 'iap'])
  source?: AdminWebhookSource;

  @IsOptional()
  @IsIn(['ok', 'ignored', 'error'])
  outcome?: AdminWebhookOutcome;
}
