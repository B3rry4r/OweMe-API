import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Public } from '../../common';
import { AdminJwtGuard, AdminRoles, AdminRolesGuard } from '../common';
import { AdminBusinessesService } from './admin-businesses.service';
import {
  AdminBusinessDebtView,
  AdminBusinessDetailView,
  AdminBusinessView,
  AdminCreditUsageView,
  Paged,
} from './admin-businesses.views';
import {
  AdminBusinessDebtsQueryDto,
  AdminBusinessListQueryDto,
} from './dto/admin-businesses.dto';

/**
 * Business monitor reads, superadmin + support (registry AdminBusinessesView). READ-ONLY:
 * every mutation on a business (suspend, force-plan, grant-credits, test flags) belongs to
 * the AdminBusinessActions resource, so nothing here is audit-logged.
 *   GET /admin/businesses                  -> 200 Paged<AdminBusinessView>.
 *   GET /admin/businesses/:id              -> 200 AdminBusinessDetailView | 404 NOT_FOUND.
 *   GET /admin/businesses/:id/credit-usage -> 200 AdminCreditUsageView | 404 NOT_FOUND.
 *   GET /admin/businesses/:id/debts        -> 200 Paged<AdminBusinessDebtView> | 404 NOT_FOUND.
 */
@Controller('admin/businesses')
@Public()
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles('superadmin', 'support')
export class AdminBusinessesController {
  constructor(private readonly businesses: AdminBusinessesService) {}

  @Get()
  list(@Query() query: AdminBusinessListQueryDto): Promise<Paged<AdminBusinessView>> {
    return this.businesses.list(query);
  }

  @Get(':id')
  detail(@Param('id') id: string): Promise<AdminBusinessDetailView> {
    return this.businesses.detail(id);
  }

  @Get(':id/credit-usage')
  creditUsage(@Param('id') id: string): Promise<AdminCreditUsageView> {
    return this.businesses.creditUsage(id);
  }

  @Get(':id/debts')
  debts(
    @Param('id') id: string,
    @Query() query: AdminBusinessDebtsQueryDto,
  ): Promise<Paged<AdminBusinessDebtView>> {
    return this.businesses.debts(id, query);
  }
}
