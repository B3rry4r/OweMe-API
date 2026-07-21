import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Public } from '../../common';
import { AdminJwtGuard, AdminRoles, AdminRolesGuard } from '../common';
import { AdminPayoutsService } from './admin-payouts.service';
import { AdminPayoutAccountView, AdminPayoutStatsView, Paged } from './admin-payouts.views';
import { PayoutAccountsQueryDto } from './dto/admin-payouts.dto';

/**
 * Payout-account monitor, superadmin + support (registry AdminPayoutsView).
 * GET-only: payout accounts are written by the trader through the protected app
 * surface, so no admin write route exists here.
 *   GET /admin/payouts/accounts -> 200 Paged<AdminPayoutAccountView>.
 *   GET /admin/payouts/stats    -> 200 AdminPayoutStatsView.
 */
@Controller('admin/payouts')
@Public()
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles('superadmin', 'support')
export class AdminPayoutsController {
  constructor(private readonly payouts: AdminPayoutsService) {}

  @Get('accounts')
  accounts(@Query() query: PayoutAccountsQueryDto): Promise<Paged<AdminPayoutAccountView>> {
    return this.payouts.accounts(query);
  }

  @Get('stats')
  stats(): Promise<AdminPayoutStatsView> {
    return this.payouts.stats();
  }
}
