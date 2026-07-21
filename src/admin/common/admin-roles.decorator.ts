import { SetMetadata } from '@nestjs/common';
import { AdminRole } from './admin-principal';

export const ADMIN_ROLES_KEY = 'adminRoles';

/** @AdminRoles('superadmin') / @AdminRoles('superadmin', 'support') - enforced by AdminRolesGuard. */
export const AdminRoles = (...roles: AdminRole[]) => SetMetadata(ADMIN_ROLES_KEY, roles);
