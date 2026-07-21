import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Public } from '../../common';
import { AdminJwtGuard, AdminRoles, AdminRolesGuard } from '../common';
import { AdminDebtsService } from './admin-debts.service';
import { AdminDebtStatsView, AdminDebtView, Paged } from './admin-debts.views';
import { AdminDebtsQueryDto } from './dto/admin-debts.dto';

/**
 * Cross-tenant debt reads, superadmin + support (registry AdminDebtsView). GET-only:
 * the admin debts surface is a monitor, every mutation stays in the app's own
 * tenant-scoped endpoints.
 *   GET /admin/debts       -> 200 Paged<AdminDebtView>.
 *   GET /admin/debts/stats -> 200 AdminDebtStatsView.
 */
@Controller('admin/debts')
@Public()
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles('superadmin', 'support')
export class AdminDebtsController {
  constructor(private readonly debts: AdminDebtsService) {}

  @Get()
  list(@Query() query: AdminDebtsQueryDto): Promise<Paged<AdminDebtView>> {
    return this.debts.list(query);
  }

  @Get('stats')
  stats(): Promise<AdminDebtStatsView> {
    return this.debts.stats();
  }
}
