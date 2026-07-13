import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { PAGINATION_DEFAULT_LIMIT, PAGINATION_MAX_LIMIT } from '../common';

/** Base cursor-pagination query (?cursor&limit, default 20, max 100). Extend per resource. */
export class PaginationQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGINATION_MAX_LIMIT)
  limit?: number = PAGINATION_DEFAULT_LIMIT;
}
