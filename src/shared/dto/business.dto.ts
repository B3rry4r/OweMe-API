import { IsIn, IsOptional, IsString, IsNotEmpty } from 'class-validator';
import { REMINDER_TONE_VALUES, ReminderTone } from '../enums';

/** PUT /business — upsert the single per-tenant profile. plan/paystackSubaccount not settable here. */
export class UpdateBusinessDto {
  @IsString()
  @IsNotEmpty()
  businessName!: string;

  @IsOptional()
  @IsString()
  ownerName?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsIn(REMINDER_TONE_VALUES)
  reminderTone?: ReminderTone;
}
