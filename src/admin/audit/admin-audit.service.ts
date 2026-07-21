import { Injectable } from '@nestjs/common';
import type { AdminAuditLog, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { uuidv7 } from '../../common';
import { PAGINATION_DEFAULT_LIMIT } from '../../shared';
import { AdminRole } from '../common';
import { AuditLogQueryDto } from './dto/admin-audit.dto';
import { AdminAuditEntryView, AdminNameRef, Paged } from './admin-audit.views';

/**
 * The ONE audit writer + reader for the admin surface (registry AdminAuditLog).
 * Every admin write endpoint appends its admin_audit_log row through record();
 * the table is APPEND-ONLY by contract - no update or delete path exists anywhere,
 * and this module deliberately exposes no create/update/delete route. Rows carry
 * actor name/role snapshots so they stay self-contained even if the AdminUser row
 * is later removed (revoke-invite hard delete of never-activated accounts).
 */

export interface AdminAuditActor {
  adminId: string;
  name: string;
  role: AdminRole;
}

export interface AdminAuditEntry {
  /** Kebab verb from the registry vocabulary, e.g. 'login', 'create-admin'. */
  actionType: string;
  /** Human-readable sentence. */
  action: string;
  targetType?: string;
  targetId?: string;
  targetBusinessId?: string;
  before?: Prisma.InputJsonObject;
  after?: Prisma.InputJsonObject;
  note?: string;
}

@Injectable()
export class AdminAuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** The single write helper every admin module injects. AdminPrincipal satisfies the actor shape. */
  async record(actor: AdminAuditActor, entry: AdminAuditEntry): Promise<void> {
    await this.prisma.adminAuditLog.create({
      data: {
        id: uuidv7(),
        adminUserId: actor.adminId,
        adminNameSnapshot: actor.name,
        adminRoleSnapshot: actor.role,
        actionType: entry.actionType,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        targetBusinessId: entry.targetBusinessId ?? null,
        before: entry.before ?? undefined,
        after: entry.after ?? undefined,
        note: entry.note ?? null,
      },
    });
  }

  /** GET /admin/audit-log - offset-paged, newest first, empty-table graceful. */
  async list(query: AuditLogQueryDto): Promise<Paged<AdminAuditEntryView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;

    const where: Prisma.AdminAuditLogWhereInput = {
      ...(query.adminId ? { adminUserId: query.adminId } : {}),
      ...(query.actionType ? { actionType: query.actionType } : {}),
      ...(query.month ? { createdAt: this.monthRange(query.month) } : {}),
    };
    // targetBusinessId and targetBusinessSearch AND together rather than clobbering.
    const targetFilters: Prisma.AdminAuditLogWhereInput[] = [];
    if (query.targetBusinessId) {
      targetFilters.push({ targetBusinessId: query.targetBusinessId });
    }
    if (query.targetBusinessSearch) {
      const matches = await this.prisma.business.findMany({
        where: { businessName: { contains: query.targetBusinessSearch } },
        select: { id: true },
      });
      targetFilters.push({ targetBusinessId: { in: matches.map((b) => b.id) } });
    }
    if (targetFilters.length > 0) where.AND = targetFilters;

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.adminAuditLog.count({ where }),
      this.prisma.adminAuditLog.findMany({
        where,
        // uuidv7 id desc tiebreaks same-millisecond rows in creation order.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const nameById = await this.businessNames(rows);
    return { data: rows.map((row) => this.toView(row, nameById)), page, total };
  }

  /**
   * GET /admin/audit-log/admins - id+name enumeration for the filter dropdown only.
   * Deliberately NOT the superadmin-gated management list: support sees who acted
   * without seeing emails or status.
   */
  async admins(): Promise<AdminNameRef[]> {
    return this.prisma.adminUser.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  // --- internals -----------------------------------------------------------

  /** Resolve targetBusinessName for the page's rows in one query; null when the id is gone. */
  private async businessNames(rows: AdminAuditLog[]): Promise<Map<string, string>> {
    const ids = [
      ...new Set(rows.map((r) => r.targetBusinessId).filter((id): id is string => id !== null)),
    ];
    if (ids.length === 0) return new Map();
    const businesses = await this.prisma.business.findMany({
      where: { id: { in: ids } },
      select: { id: true, businessName: true },
    });
    return new Map(businesses.map((b) => [b.id, b.businessName]));
  }

  /** [start, end) UTC bounds for a YYYY-MM month. */
  private monthRange(month: string): { gte: Date; lt: Date } {
    const [year, monthIndex] = month.split('-').map(Number);
    return {
      gte: new Date(Date.UTC(year, monthIndex - 1, 1)),
      lt: new Date(Date.UTC(year, monthIndex, 1)),
    };
  }

  private toView(row: AdminAuditLog, businessNameById: Map<string, string>): AdminAuditEntryView {
    return {
      id: row.id,
      at: row.createdAt.toISOString(),
      adminId: row.adminUserId,
      adminName: row.adminNameSnapshot,
      adminRole: row.adminRoleSnapshot as AdminRole,
      actionType: row.actionType,
      action: row.action,
      targetBusinessId: row.targetBusinessId,
      targetBusinessName:
        row.targetBusinessId !== null
          ? businessNameById.get(row.targetBusinessId) ?? null
          : null,
      targetType: row.targetType,
      targetId: row.targetId,
      before: row.before === null ? null : (row.before as object),
      after: row.after === null ? null : (row.after as object),
      note: row.note,
    };
  }
}
