import { AdminRole } from '../common';

/** Registry AdminAuditLog response DTOs, verbatim. */

/** Admin offset-pagination envelope per conventions: { data, page, total }. */
export interface Paged<T> {
  data: T[];
  page: number;
  total: number;
}

export interface AdminAuditEntryView {
  id: string;
  at: string;
  adminId: string;
  adminName: string;
  adminRole: AdminRole;
  /** Kebab verb, e.g. grant-credits, force-plan, suspend, reveal-otp, login. */
  actionType: string;
  /** Human-readable sentence. */
  action: string;
  targetBusinessId: string | null;
  targetBusinessName: string | null;
  targetType: string | null;
  targetId: string | null;
  before: object | null;
  after: object | null;
  note: string | null;
}

export interface AdminNameRef {
  id: string;
  name: string;
}
