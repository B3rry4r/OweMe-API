import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { PAGINATION_DEFAULT_LIMIT, PAGINATION_MAX_LIMIT } from '../../../shared';

/** Registry AdminAuditLog GET /admin/audit-log query, verbatim. */
export class AuditLogQueryDto {
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
  @IsString()
  @IsNotEmpty()
  adminId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  actionType?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  targetBusinessId?: string;

  /** Business name contains. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  targetBusinessSearch?: string;

  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month?: string;
}
