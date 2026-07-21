import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Public } from '../../common';
import { AdminJwtGuard, AdminRoles, AdminRolesGuard } from '../common';
import { AdminCreditsService } from './admin-credits.service';
import {
  AdminBundlePurchaseView,
  AdminCreditsConfigView,
  AdminCreditsStatsView,
  AdminHeavyUserView,
  Paged,
} from './admin-credits.views';
import { BundlePurchasesQueryDto, HeavyUsersQueryDto } from './dto/admin-credits.dto';

/**
 * Unified OweMe-credits monitor, superadmin + support (registry AdminCreditsView).
 * READ-ONLY by design: credit grants are a test-account/superadmin write power that
 * lives with the business actions resource, never here.
 *   GET /admin/credits/stats            -> 200 AdminCreditsStatsView.
 *   GET /admin/credits/heavy-users      -> 200 Paged<AdminHeavyUserView>.
 *   GET /admin/credits/bundle-purchases -> 200 Paged<AdminBundlePurchaseView>.
 *   GET /admin/credits/config           -> 200 AdminCreditsConfigView.
 */
@Controller('admin/credits')
@Public()
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles('superadmin', 'support')
export class AdminCreditsController {
  constructor(private readonly credits: AdminCreditsService) {}

  @Get('stats')
  stats(): Promise<AdminCreditsStatsView> {
    return this.credits.stats();
  }

  @Get('heavy-users')
  heavyUsers(@Query() query: HeavyUsersQueryDto): Promise<Paged<AdminHeavyUserView>> {
    return this.credits.heavyUsers(query);
  }

  @Get('bundle-purchases')
  bundlePurchases(
    @Query() query: BundlePurchasesQueryDto,
  ): Promise<Paged<AdminBundlePurchaseView>> {
    return this.credits.bundlePurchases(query);
  }

  @Get('config')
  config(): Promise<AdminCreditsConfigView> {
    return this.credits.config();
  }
}
