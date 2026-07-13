import { SetMetadata } from '@nestjs/common';
import { Role } from '../../shared';

export const ROLES_KEY = 'roles';

/** @Roles('owner') / @Roles('owner','staff') — enforced by RolesGuard. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
