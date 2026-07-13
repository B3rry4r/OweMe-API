import { IsIn, IsOptional, IsString, IsNotEmpty, IsDateString } from 'class-validator';
import { REMINDER_CHANNEL_VALUES, REMINDER_STATUS_VALUES, ReminderChannel } from '../enums';
import { PaginationQueryDto } from './pagination.dto';

/** POST /reminders — records history. sms/whatsapp debit allowance; others free. Idempotent on id. */
export class CreateReminderDto {
  @IsString()
  @IsNotEmpty()
  id!: string; // client-minted UUIDv7

  @IsString()
  @IsNotEmpty()
  debtId!: string;

  @IsIn(REMINDER_CHANNEL_VALUES)
  channel!: ReminderChannel;

  @IsOptional()
  @IsString()
  message?: string;

  @IsOptional()
  @IsString()
  payLinkUrl?: string;

  @IsOptional()
  @IsDateString()
  scheduledFor?: string;
}

export class ListRemindersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(REMINDER_STATUS_VALUES)
  status?: (typeof REMINDER_STATUS_VALUES)[number];
}
