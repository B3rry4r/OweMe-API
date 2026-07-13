import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { Notification, Paginated, PaginationQueryDto } from '../shared';
import { Roles, BusinessId } from '../common';
import { NotificationsService } from './notifications.service';

/**
 * Notifications — the owner's in-app feed. Owner-only surface; tenancy always from the JWT.
 *   GET  /notifications                 -> Paginated<Notification>, createdAt desc.
 *   POST /notifications/mark-all-read   -> 204; marks the whole business's feed read.
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @Roles('owner')
  list(
    @BusinessId() businessId: string,
    @Query() query: PaginationQueryDto,
  ): Promise<Paginated<Notification>> {
    return this.notifications.list(businessId, query.cursor, query.limit);
  }

  @Post('mark-all-read')
  @Roles('owner')
  @HttpCode(204)
  markAllRead(@BusinessId() businessId: string): Promise<void> {
    return this.notifications.markAllRead(businessId);
  }
}
