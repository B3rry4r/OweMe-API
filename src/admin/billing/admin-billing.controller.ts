import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Public } from '../../common';
import { AdminJwtGuard, AdminRoles, AdminRolesGuard } from '../common';
import { AdminBillingService } from './admin-billing.service';
import {
  AdminBillingStatsView,
  AdminBillingTransactionView,
  AdminIapLifecycleView,
  AdminSubscriptionView,
  Paged,
} from './admin-billing.views';
import {
  AdminBillingTransactionsQueryDto,
  AdminIapLifecycleQueryDto,
  AdminSubscriptionsQueryDto,
} from './dto/admin-billing.dto';

/**
 * Billing monitor, superadmin only per the conventions billing matrix (support may
 * never see billing). GET-only: entitlements and transactions are written by the
 * app's protected billing/webhook paths, never over the admin surface.
 *   GET /admin/billing/subscriptions -> 200 Paged<AdminSubscriptionView>.
 *   GET /admin/billing/transactions  -> 200 Paged<AdminBillingTransactionView>.
 *   GET /admin/billing/stats         -> 200 AdminBillingStatsView.
 *   GET /admin/billing/iap-lifecycle -> 200 AdminIapLifecycleView.
 */
@Controller('admin/billing')
@Public()
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles('superadmin')
export class AdminBillingController {
  constructor(private readonly billing: AdminBillingService) {}

  @Get('subscriptions')
  subscriptions(
    @Query() query: AdminSubscriptionsQueryDto,
  ): Promise<Paged<AdminSubscriptionView>> {
    return this.billing.subscriptions(query);
  }

  @Get('transactions')
  transactions(
    @Query() query: AdminBillingTransactionsQueryDto,
  ): Promise<Paged<AdminBillingTransactionView>> {
    return this.billing.transactions(query);
  }

  @Get('stats')
  stats(): Promise<AdminBillingStatsView> {
    return this.billing.stats();
  }

  @Get('iap-lifecycle')
  iapLifecycle(@Query() query: AdminIapLifecycleQueryDto): Promise<AdminIapLifecycleView> {
    return this.billing.iapLifecycle(query);
  }
}
