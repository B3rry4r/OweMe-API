import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationPreferences, UpdateNotificationPreferencesDto } from '../shared';

/**
 * NotificationPreferences service — one row per business (businessId is the @id).
 * Scoped to the JWT businessId; never trusts a client-sent businessId.
 * Ruling: servePersisted. Booleans persist so backend push honors them.
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /notification-preferences — the tenant's prefs row.
   * Lazily creates defaults (payments/overdue/delivery=true, weekly=false) on first read.
   */
  async get(businessId: string): Promise<NotificationPreferences> {
    const row = await this.prisma.notificationPreferences.upsert({
      where: { businessId },
      create: { businessId },
      update: {},
    });
    return row as unknown as NotificationPreferences;
  }

  /**
   * PUT /notification-preferences — set all four booleans and bump version.
   * Upsert-by-businessId: creates the row if absent, else overwrites.
   */
  async update(
    businessId: string,
    dto: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreferences> {
    const data = {
      payments: dto.payments,
      overdue: dto.overdue,
      delivery: dto.delivery,
      weekly: dto.weekly,
    };
    const row = await this.prisma.notificationPreferences.upsert({
      where: { businessId },
      create: { businessId, ...data },
      update: { ...data, version: { increment: 1 } },
    });
    return row as unknown as NotificationPreferences;
  }
}
