import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Public } from '../../common';
import {
  AdminJwtGuard,
  AdminPrincipal,
  AdminRoles,
  AdminRolesGuard,
  AllowPendingPassword,
  CurrentAdmin,
} from '../common';
import { AdminAuthService } from './admin-auth.service';
import { AdminSelfView, AdminSessionView } from './admin-auth.views';
import { AdminChangePasswordDto, AdminLoginDto, AdminRefreshDto } from './dto/admin-auth.dto';

/**
 * Admin auth, credential leg. @Public() opts the routes out of the GLOBAL user
 * JwtAuthGuard (admin territory per the registry tokenDesign); login/refresh carry
 * no admin guard because they ARE the credential exchange.
 *   POST /admin/auth/login   -> 200 AdminSessionView (401 on bad creds or disabled).
 *   POST /admin/auth/refresh -> 200 AdminSessionView (rotation + reuse detection).
 */
@Controller('admin/auth')
@Public()
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() dto: AdminLoginDto): Promise<AdminSessionView> {
    return this.auth.login(dto.email, dto.password);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: AdminRefreshDto): Promise<AdminSessionView> {
    return this.auth.refresh(dto.refreshToken);
  }
}

/**
 * Admin auth, session leg: bearer-gated by the ADMIN guards (controller-level, per
 * conventions). Both routes are @AllowPendingPassword(): they are the only /admin/*
 * surface a mustChangePassword admin may reach.
 *   GET  /admin/auth/me              -> 200 AdminSelfView.
 *   POST /admin/auth/change-password -> 200 { ok: true } (401 wrong current password).
 */
@Controller('admin/auth')
@Public()
@UseGuards(AdminJwtGuard, AdminRolesGuard)
export class AdminSessionController {
  constructor(private readonly auth: AdminAuthService) {}

  @Get('me')
  @AdminRoles('superadmin', 'support')
  @AllowPendingPassword()
  me(@CurrentAdmin('adminId') adminId: string): Promise<AdminSelfView> {
    return this.auth.me(adminId);
  }

  @Post('change-password')
  @AdminRoles('superadmin', 'support')
  @AllowPendingPassword()
  @HttpCode(200)
  changePassword(
    @CurrentAdmin() admin: AdminPrincipal,
    @Body() dto: AdminChangePasswordDto,
  ): Promise<{ ok: true }> {
    return this.auth.changePassword(admin, dto.currentPassword, dto.newPassword);
  }
}
