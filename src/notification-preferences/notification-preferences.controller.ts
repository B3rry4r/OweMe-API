import { Body, Controller, Get, Put } from '@nestjs/common';
import { NotificationPreferences, UpdateNotificationPreferencesDto } from '../shared';
import { Roles, BusinessId } from '../common';
import { NotificationPreferencesService } from './notification-preferences.service';

/**
 * NotificationPreferences — the owner-only push preferences surface (one row per business).
 *   GET /notification-preferences  (owner) -> current prefs; lazily creates defaults on first read.
 *   PUT /notification-preferences  (owner) -> set all four booleans.
 * Tenancy: businessId always comes from the JWT (@BusinessId), never the client body.
 */
@Controller('notification-preferences')
export class NotificationPreferencesController {
  constructor(private readonly prefs: NotificationPreferencesService) {}

  @Get()
  @Roles('owner')
  get(@BusinessId() businessId: string): Promise<NotificationPreferences> {
    return this.prefs.get(businessId);
  }

  @Put()
  @Roles('owner')
  update(
    @BusinessId() businessId: string,
    @Body() dto: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreferences> {
    return this.prefs.update(businessId, dto);
  }
}
