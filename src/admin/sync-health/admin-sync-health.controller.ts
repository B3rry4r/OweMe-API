import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Public } from '../../common';
import { AdminJwtGuard, AdminRoles, AdminRolesGuard } from '../common';
import { AdminSyncHealthService } from './admin-sync-health.service';
import { AdminSyncHealthView } from './admin-sync-health.views';
import { SyncHealthQueryDto } from './dto/admin-sync-health.dto';

/**
 * Sync-health monitor, superadmin + support (registry AdminSyncHealthView, gap-4).
 * READ-ONLY by design: the surface exposes exactly one GET and no write route, because
 * every remedy for the limitations it reports lives in protected app code.
 *   GET /admin/sync-health -> 200 AdminSyncHealthView.
 */
@Controller('admin/sync-health')
@Public()
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles('superadmin', 'support')
export class AdminSyncHealthController {
  constructor(private readonly syncHealth: AdminSyncHealthService) {}

  @Get()
  overview(@Query() query: SyncHealthQueryDto): Promise<AdminSyncHealthView> {
    return this.syncHealth.overview(query);
  }
}
