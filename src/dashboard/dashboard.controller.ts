import { Controller, Get } from '@nestjs/common';
import { DashboardResponse } from '../shared';
import { BusinessId, Roles } from '../common';
import { DashboardService } from './dashboard.service';

/**
 * Dashboard — the home screen summary. DERIVED (owns no table); tenancy is always the JWT
 * businessId. Core-recovery surface: roles owner|staff, never plan-gated.
 *   GET /dashboard -> DashboardResponse (money kobo; activity capped at 8, `at` desc).
 */
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @Roles('owner', 'staff')
  summary(@BusinessId() businessId: string): Promise<DashboardResponse> {
    return this.dashboard.summary(businessId);
  }
}
