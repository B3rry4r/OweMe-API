import { Controller, Get, Query } from '@nestjs/common';
import { ActivityItem, Paginated, PaginationQueryDto } from '../shared';
import { BusinessId, Roles } from '../common';
import { ActivityService } from './activity.service';

/**
 * Activity — derived union feed (payments + non-deleted debts + sent reminders), `at` desc.
 * Tenant-scoped from the JWT businessId. No own table.
 *   GET /activity?cursor&limit -> Paginated<ActivityItem>. owner|staff
 */
@Controller('activity')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  @Roles('owner', 'staff')
  list(
    @BusinessId() businessId: string,
    @Query() query: PaginationQueryDto,
  ): Promise<Paginated<ActivityItem>> {
    return this.activity.list(businessId, query);
  }
}
