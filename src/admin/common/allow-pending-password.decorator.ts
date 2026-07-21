import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_PASSWORD_KEY = 'adminAllowPendingPassword';

/**
 * Exempts an admin route from the mustChangePassword lockout. Per the registry,
 * ONLY /admin/auth/me and /admin/auth/change-password carry this; every other
 * /admin/* endpoint returns 403 FORBIDDEN until the temp password is changed.
 */
export const AllowPendingPassword = () => SetMetadata(ALLOW_PENDING_PASSWORD_KEY, true);
