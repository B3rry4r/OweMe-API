import { IsBoolean } from 'class-validator';

/** PUT /notification-preferences. */
export class UpdateNotificationPreferencesDto {
  @IsBoolean()
  payments!: boolean;

  @IsBoolean()
  overdue!: boolean;

  @IsBoolean()
  delivery!: boolean;

  @IsBoolean()
  weekly!: boolean;
}
