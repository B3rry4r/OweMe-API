import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Notification, Paginated, PAGINATION_DEFAULT_LIMIT } from '../shared';

/**
 * Notifications service. Tenant-scoped by the JWT businessId (never trusts client tenancy).
 * Feed is ordered createdAt desc (id desc as a stable tiebreaker for cursor paging).
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /notifications — cursor page of the business's notifications, newest first.
   * Opaque cursor is the last row's id; nextCursor is null on the final page.
   */
  async list(
    businessId: string,
    cursor: string | undefined,
    limit: number = PAGINATION_DEFAULT_LIMIT,
  ): Promise<Paginated<Notification>> {
    const take = limit ?? PAGINATION_DEFAULT_LIMIT;
    const rows = await this.prisma.notification.findMany({
      where: { businessId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > take;
    const data = hasMore ? rows.slice(0, take) : rows;
    const nextCursor = hasMore ? data[data.length - 1].id : null;

    return { data: data as unknown as Notification[], nextCursor };
  }

  /** POST /notifications/mark-all-read — flip read=true for every row of the business. */
  async markAllRead(businessId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { businessId, read: false },
      data: { read: true, version: { increment: 1 } },
    });
  }
}
