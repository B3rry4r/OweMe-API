import { Controller, Get, UseGuards } from '@nestjs/common';
import { Public } from '../../common';
import { AdminJwtGuard, AdminRoles, AdminRolesGuard } from '../common';
import { AdminPlansService } from './admin-plans.service';
import { AdminPlanView } from './admin-plans.views';

/**
 * Plan catalog reads for the dashboard, superadmin + support (registry AdminPlansView).
 * Read-only surface: plan rows are seeded reference data, so there is no write route
 * and nothing to audit-log here.
 *   GET /admin/plans -> 200 AdminPlanView[] in ladder order.
 */
@Controller('admin/plans')
@Public()
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles('superadmin', 'support')
export class AdminPlansController {
  constructor(private readonly plans: AdminPlansService) {}

  @Get()
  list(): Promise<AdminPlanView[]> {
    return this.plans.list();
  }
}
