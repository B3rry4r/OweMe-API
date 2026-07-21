import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Public } from '../../common';
import {
  AdminJwtGuard,
  AdminPrincipal,
  AdminRoles,
  AdminRolesGuard,
  CurrentAdmin,
} from '../common';
import { AdminUsersService } from './admin-users.service';
import { AdminUserCreatedView, AdminUserView } from './admin-users.views';
import { CreateAdminUserDto } from './dto/admin-users.dto';

/**
 * Admin-user management, superadmin only (class-level @AdminRoles gate).
 *   GET    /admin/admin-users             -> 200 AdminUserView[].
 *   POST   /admin/admin-users             -> 201 { admin, tempPassword } (shown once).
 *   POST   /admin/admin-users/:id/disable -> AdminUserView (self-disable -> 422).
 *   POST   /admin/admin-users/:id/enable  -> AdminUserView.
 *   DELETE /admin/admin-users/:id         -> { ok: true } (never-activated only).
 */
@Controller('admin/admin-users')
@Public()
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles('superadmin')
export class AdminUsersController {
  constructor(private readonly adminUsers: AdminUsersService) {}

  @Get()
  list(): Promise<AdminUserView[]> {
    return this.adminUsers.list();
  }

  @Post()
  create(
    @CurrentAdmin() actor: AdminPrincipal,
    @Body() dto: CreateAdminUserDto,
  ): Promise<AdminUserCreatedView> {
    return this.adminUsers.create(actor, dto);
  }

  @Post(':id/disable')
  disable(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
  ): Promise<AdminUserView> {
    return this.adminUsers.disable(actor, id);
  }

  @Post(':id/enable')
  enable(@CurrentAdmin() actor: AdminPrincipal, @Param('id') id: string): Promise<AdminUserView> {
    return this.adminUsers.enable(actor, id);
  }

  @Delete(':id')
  remove(@CurrentAdmin() actor: AdminPrincipal, @Param('id') id: string): Promise<{ ok: true }> {
    return this.adminUsers.remove(actor, id);
  }
}
