/** Admin roles per the admin registry tokenDesign. superadmin passes every gate. */
export type AdminRole = 'superadmin' | 'support';

export const ADMIN_ROLES: readonly AdminRole[] = ['superadmin', 'support'];

/**
 * The authenticated admin principal attached to the request by AdminJwtGuard
 * (request.admin, deliberately NOT request.user so the user-auth machinery and the
 * admin surface never share a principal slot).
 */
export interface AdminPrincipal {
  adminId: string;
  name: string;
  email: string;
  role: AdminRole;
  mustChangePassword: boolean;
  /** Id of the live admin_refresh_tokens row this session leg was minted with. */
  sessionId: string;
}
