import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsNotEmpty,
  Min,
  IsDateString,
} from 'class-validator';
import { PaginationQueryDto } from './pagination.dto';

/** POST /debts — idempotent on id. Side effect: reminder schedule generation. */
export class CreateDebtDto {
  @IsString()
  @IsNotEmpty()
  id!: string; // client-minted UUIDv7

  @IsString()
  @IsNotEmpty()
  customerId!: string;

  @IsInt()
  @Min(1)
  amount!: number; // kobo

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;
}

/** PATCH /debts/:id — If-Match version. clearDueDate=true explicitly nulls dueDate. */
export class UpdateDebtDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  amount?: number; // kobo

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsBoolean()
  clearDueDate?: boolean;
}

export const DEBT_STATUS_FILTER_VALUES = ['active', 'overdue', 'paid', 'archived'] as const;
export const DEBT_SORT_VALUES = ['most-owed', 'soonest-due', 'recently-added'] as const;

export class ListDebtsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(DEBT_STATUS_FILTER_VALUES)
  status?: (typeof DEBT_STATUS_FILTER_VALUES)[number];

  @IsOptional()
  @IsIn(DEBT_SORT_VALUES)
  sort?: (typeof DEBT_SORT_VALUES)[number];

  @IsOptional()
  @IsString()
  q?: string;
}
