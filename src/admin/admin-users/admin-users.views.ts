import { AdminRole } from '../common';

/** Registry AdminUserManagement response DTOs, verbatim. */

export interface AdminUserView {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  status: 'active' | 'disabled';
  /** mustChangePassword && lastLoginAt null; renders as the screen's 'invited' state. */
  pendingFirstLogin: boolean;
  lastActiveAt: string | null;
}

export interface AdminUserCreatedView {
  admin: AdminUserView;
  /** Shown once in this response, never retrievable again. */
  tempPassword: string;
}
