import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenAppException, UnauthenticatedException } from '../../common';
import { AdminPrincipal, AdminRole } from './admin-principal';
import { ADMIN_ROLES_KEY } from './admin-roles.decorator';

/**
 * Enforces @AdminRoles() on the admin surface (runs after AdminJwtGuard). Per the
 * conventions role matrix, superadmin passes ANY gate; support passes only where
 * explicitly listed. No metadata = authenticated-admin-only.
 */
@Injectable()
export class AdminRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AdminRole[]>(ADMIN_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<{ admin?: AdminPrincipal }>();
    const admin = req.admin;
    if (!admin) throw new UnauthenticatedException();

    if (admin.role === 'superadmin') return true;
    if (required.includes(admin.role)) return true;

    throw new ForbiddenAppException('Your admin role cannot perform this action');
  }
}
