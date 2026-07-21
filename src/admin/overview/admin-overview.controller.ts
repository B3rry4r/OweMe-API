import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Public } from '../../common';
import { AdminJwtGuard, AdminRoles, AdminRolesGuard } from '../common';
import { AdminOverviewService } from './admin-overview.service';
import { AdminOverviewView, AdminPlatformEventView } from './admin-overview.views';
import { OverviewActivityQueryDto } from './dto/admin-overview.dto';

/**
 * Platform overview reads, superadmin + support (registry AdminOverview). GET-only:
 * every figure is aggregated from live rows at request time, nothing is written and
 * no audit rows are recorded (auditLogged: false for both endpoints).
 *   GET /admin/overview          -> 200 AdminOverviewView.
 *   GET /admin/overview/activity -> 200 AdminPlatformEventView[].
 */
@Controller('admin/overview')
@Public()
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles('superadmin', 'support')
export class AdminOverviewController {
  constructor(private readonly overview: AdminOverviewService) {}

  @Get()
  summary(): Promise<AdminOverviewView> {
    return this.overview.summary();
  }

  @Get('activity')
  activity(@Query() query: OverviewActivityQueryDto): Promise<AdminPlatformEventView[]> {
    return this.overview.activity(query);
  }
}
