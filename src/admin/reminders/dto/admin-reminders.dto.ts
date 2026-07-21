import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
  REMINDER_CHANNEL_VALUES,
  REMINDER_STATUS_VALUES,
  ReminderChannel,
  ReminderStatus,
} from '../../../shared';

/** Registry AdminRemindersView GET /admin/reminders query, verbatim. */
export class AdminRemindersQueryDto {
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
  @IsIn(REMINDER_CHANNEL_VALUES as unknown as string[])
  channel?: ReminderChannel;

  @IsOptional()
  @IsIn(REMINDER_STATUS_VALUES as unknown as string[])
  status?: ReminderStatus;
}

/** Registry AdminRemindersView GET /admin/reminders/sms-cost-series query, verbatim. */
export class AdminSmsCostSeriesQueryDto {
  /** Trailing weeks including the current one. Capped at two years of buckets. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(104)
  weeks?: number = 12;
}
