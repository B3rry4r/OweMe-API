import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { Public } from '../../common';
import {
  AdminJwtGuard,
  AdminPrincipal,
  AdminRoles,
  AdminRolesGuard,
  CurrentAdmin,
} from '../common';
import { AdminBusinessActionsService } from './admin-business-actions.service';
import {
  AdminBusinessDetailView,
  AdminCreditUsageView,
} from '../businesses/admin-businesses.views';
import { AdminResetTestBusinessView } from './admin-business-actions.views';
import {
  AdminEnterpriseBandsDto,
  AdminForcePlanDto,
  AdminGrantCreditsDto,
  AdminResetTestBusinessDto,
  AdminSuspendBusinessDto,
  AdminTestFlagDto,
} from './dto/admin-business-actions.dto';

/**
 * Business write actions, superadmin only (class-level @AdminRoles gate; support is
 * blocked from billing, plans, bands, credit grants, test-account powers and destructive
 * actions by the conventions role matrix). Every route is audit-logged in the service.
 *   POST /admin/businesses/:id/test-flag         -> AdminBusinessDetailView.
 *   POST /admin/businesses/:id/grant-credits     -> AdminCreditUsageView.
 *   POST /admin/businesses/:id/force-plan        -> AdminBusinessDetailView.
 *   POST /admin/businesses/:id/enterprise-bands  -> AdminBusinessDetailView (422 off-plan).
 *   POST /admin/businesses/:id/reset-test        -> { ok, cleared } (403 unless isTest).
 *   POST /admin/businesses/:id/suspend           -> AdminBusinessDetailView (422 if already).
 *   POST /admin/businesses/:id/unsuspend         -> AdminBusinessDetailView (422 if not).
 *
 * The read routes on the same base path belong to AdminBusinessesController; this class
 * adds only the POST verbs, so the monitor stays read-only.
 */
@Controller('admin/businesses')
@Public()
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles('superadmin')
export class AdminBusinessActionsController {
  constructor(private readonly actions: AdminBusinessActionsService) {}

  @Post(':id/test-flag')
  testFlag(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
    @Body() dto: AdminTestFlagDto,
  ): Promise<AdminBusinessDetailView> {
    return this.actions.setTestFlag(actor, id, dto.isTest);
  }

  @Post(':id/grant-credits')
  grantCredits(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
    @Body() dto: AdminGrantCreditsDto,
  ): Promise<AdminCreditUsageView> {
    return this.actions.grantCredits(actor, id, dto.credits);
  }

  @Post(':id/force-plan')
  forcePlan(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
    @Body() dto: AdminForcePlanDto,
  ): Promise<AdminBusinessDetailView> {
    return this.actions.forcePlan(actor, id, dto.plan);
  }

  @Post(':id/enterprise-bands')
  enterpriseBands(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
    @Body() dto: AdminEnterpriseBandsDto,
  ): Promise<AdminBusinessDetailView> {
    return this.actions.setEnterpriseBands(actor, id, dto.extraBands);
  }

  @Post(':id/reset-test')
  resetTest(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
    @Body() dto: AdminResetTestBusinessDto,
  ): Promise<AdminResetTestBusinessView> {
    return this.actions.resetTestBusiness(actor, id, dto.confirm);
  }

  @Post(':id/suspend')
  suspend(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
    @Body() dto: AdminSuspendBusinessDto,
  ): Promise<AdminBusinessDetailView> {
    return this.actions.suspend(actor, id, dto.note);
  }

  @Post(':id/unsuspend')
  unsuspend(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
  ): Promise<AdminBusinessDetailView> {
    return this.actions.unsuspend(actor, id);
  }
}
