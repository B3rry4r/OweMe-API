import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Public } from '../../common';
import { AdminJwtGuard, AdminRoles, AdminRolesGuard } from '../common';
import { AdminDebtsService } from './admin-debts.service';
import { AdminPaymentView, Paged } from './admin-debts.views';
import { AdminPaymentsQueryDto } from './dto/admin-debts.dto';

/**
 * Cross-tenant recent-payments feed, superadmin + support (registry AdminDebtsView,
 * third endpoint - it ships with the debts resource because it reads the same
 * recovery data). GET-only.
 *   GET /admin/payments -> 200 Paged<AdminPaymentView>.
 */
@Controller('admin/payments')
@Public()
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles('superadmin', 'support')
export class AdminPaymentsController {
  constructor(private readonly debts: AdminDebtsService) {}

  @Get()
  list(@Query() query: AdminPaymentsQueryDto): Promise<Paged<AdminPaymentView>> {
    return this.debts.payments(query);
  }
}
