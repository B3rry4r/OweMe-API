import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Public } from '../../common';
import { AdminJwtGuard, AdminRoles, AdminRolesGuard } from '../common';
import { AdminPayLinksService } from './admin-pay-links.service';
import {
  AdminPayLinkPaymentView,
  AdminPayLinkStatsView,
  Paged,
} from './admin-pay-links.views';
import { PayLinkPaymentsQueryDto, PayLinkStatsQueryDto } from './dto/admin-pay-links.dto';

/**
 * Pay-link money reads, superadmin + support (registry AdminPayLinksView). GET-only:
 * nothing here writes, so no audit rows are recorded.
 *   GET /admin/pay-links/payments -> 200 Paged<AdminPayLinkPaymentView>.
 *   GET /admin/pay-links/stats    -> 200 AdminPayLinkStatsView.
 */
@Controller('admin/pay-links')
@Public()
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles('superadmin', 'support')
export class AdminPayLinksController {
  constructor(private readonly payLinks: AdminPayLinksService) {}

  @Get('payments')
  payments(
    @Query() query: PayLinkPaymentsQueryDto,
  ): Promise<Paged<AdminPayLinkPaymentView>> {
    return this.payLinks.payments(query);
  }

  @Get('stats')
  stats(@Query() query: PayLinkStatsQueryDto): Promise<AdminPayLinkStatsView> {
    return this.payLinks.stats(query);
  }
}
