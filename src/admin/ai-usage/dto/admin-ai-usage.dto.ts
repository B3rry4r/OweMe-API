import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { PLAN_ID_VALUES, PlanId } from '../../../shared';

/** Registry AdminAiUsageView query DTOs, verbatim (page/limit 1..50 default 10). */

/** Registry-frozen paging bounds for this resource (1..50, default 10). */
export const AI_USAGE_DEFAULT_LIMIT = 10;
export const AI_USAGE_MAX_LIMIT = 50;

export class AiSeriesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(52)
  weeks?: number = 12;
}

export class AiByBusinessQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(AI_USAGE_MAX_LIMIT)
  limit?: number = AI_USAGE_DEFAULT_LIMIT;

  @IsOptional()
  @IsIn(PLAN_ID_VALUES)
  plan?: PlanId;
}

export class AiRecentParsesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(AI_USAGE_MAX_LIMIT)
  limit?: number = AI_USAGE_DEFAULT_LIMIT;
}
