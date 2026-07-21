import { Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { Public } from '../../common';
import {
  AdminJwtGuard,
  AdminPrincipal,
  AdminRoles,
  AdminRolesGuard,
  CurrentAdmin,
} from '../common';
import { AdminOtpRevealService } from './admin-otp-reveal.service';
import { AdminOtpRevealView } from './admin-otp-reveal.views';

/**
 * Test-account OTP reveal, superadmin only (registry AdminOtpReveal). It shares the
 * /admin/auth-monitor prefix with the read-only monitor controller but is a separate,
 * more tightly gated resource: support reads the monitor, only superadmin reveals a code.
 * POST rather than GET because every reveal writes an audit row.
 *   POST /admin/auth-monitor/test-numbers/:businessId/reveal
 *        -> 200 AdminOtpRevealView | 404 NOT_FOUND (no business, not test-flagged,
 *           or no active code - indistinguishable by design).
 */
@Controller('admin/auth-monitor')
@Public()
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles('superadmin')
export class AdminOtpRevealController {
  constructor(private readonly otpReveal: AdminOtpRevealService) {}

  @Post('test-numbers/:businessId/reveal')
  @HttpCode(200)
  reveal(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('businessId') businessId: string,
  ): Promise<AdminOtpRevealView> {
    return this.otpReveal.reveal(actor, businessId);
  }
}
