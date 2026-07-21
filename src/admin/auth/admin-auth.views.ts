import { AdminRole } from '../common';

/** Registry AdminAuth response DTOs, verbatim. Admin views are always distinct from app DTOs. */

export interface AdminSelfView {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  /** Static org copy for the login footer. */
  org: 'OweMe';
  mustChangePassword: boolean;
}

export interface AdminSessionView {
  accessToken: string;
  refreshToken: string;
  admin: AdminSelfView;
}
