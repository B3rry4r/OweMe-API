import { IsIn, IsOptional, IsString, IsNotEmpty } from 'class-validator';
import { PaginationQueryDto } from './pagination.dto';

/** POST /customers — idempotent on client-minted id. */
export class CreateCustomerDto {
  @IsString()
  @IsNotEmpty()
  id!: string; // client-minted UUIDv7

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  phone!: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsString()
  address?: string;
}

export const CUSTOMER_FILTER_VALUES = ['all', 'owing', 'overdue', 'paid-up'] as const;
export const CUSTOMER_SORT_VALUES = ['most-owed', 'recently-active', 'name'] as const;

export class ListCustomersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(CUSTOMER_FILTER_VALUES)
  filter?: (typeof CUSTOMER_FILTER_VALUES)[number];

  @IsOptional()
  @IsIn(CUSTOMER_SORT_VALUES)
  sort?: (typeof CUSTOMER_SORT_VALUES)[number];

  @IsOptional()
  @IsString()
  q?: string;
}
