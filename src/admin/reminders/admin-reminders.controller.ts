import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Public } from '../../common';
import { AdminJwtGuard, AdminRoles, AdminRolesGuard } from '../common';
import { AdminRemindersService } from './admin-reminders.service';
import {
  AdminReminderStatsView,
  AdminReminderView,
  AdminSmsCostPointView,
  Paged,
} from './admin-reminders.views';
import { AdminRemindersQueryDto, AdminSmsCostSeriesQueryDto } from './dto/admin-reminders.dto';

/**
 * Reminder monitor reads, superadmin + support (registry AdminRemindersView).
 * GET-only: reminder WRITES (the support retry action) are a separate wave-3
 * resource, so nothing here can dispatch an SMS or debit a trader's credits.
 *   GET /admin/reminders/stats           -> 200 AdminReminderStatsView.
 *   GET /admin/reminders                 -> 200 Paged<AdminReminderView>.
 *   GET /admin/reminders/sms-cost-series -> 200 AdminSmsCostPointView[].
 */
@Controller('admin/reminders')
@Public()
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles('superadmin', 'support')
export class AdminRemindersController {
  constructor(private readonly reminders: AdminRemindersService) {}

  @Get('stats')
  stats(): Promise<AdminReminderStatsView> {
    return this.reminders.stats();
  }

  @Get('sms-cost-series')
  smsCostSeries(@Query() query: AdminSmsCostSeriesQueryDto): Promise<AdminSmsCostPointView[]> {
    return this.reminders.smsCostSeries(query);
  }

  @Get()
  list(@Query() query: AdminRemindersQueryDto): Promise<Paged<AdminReminderView>> {
    return this.reminders.list(query);
  }
}
