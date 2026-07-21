import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PAGINATION_DEFAULT_LIMIT } from '../../shared';
import { SyncHealthQueryDto } from './dto/admin-sync-health.dto';
import {
  AdminSyncBusinessView,
  AdminSyncHealthView,
  AdminSyncTotalsView,
  Paged,
} from './admin-sync-health.views';

/**
 * Sync-health monitor (registry AdminSyncHealthView, need gap-4). Owns NO table:
 * it reads the protected Customer / Debt / Payment / Business rows only, and writes
 * nothing (no audit row - the resource is auditLogged: false because it is read-only).
 *
 * What it answers for support: how much tombstone traffic a business carries, how
 * recently it wrote anything at all, and which sync gaps are KNOWN so a desync report
 * is triaged instead of investigated from scratch. Fixing those gaps is protected-surface
 * work and deliberately out of admin scope.
 */

/**
 * Support-facing limitation copy. Sourced from the protected registry + src/sync/sync.service.ts;
 * static because every one of them is a property of the shipped v1 schema, not of the data.
 */
const KNOWN_LIMITATIONS: string[] = [
  'POST /debts/:id/undo-payment HARD-deletes the Payment row and Payment has no soft-delete column, so the delete produces NO sync tombstone: offline devices keep the removed payment (and a wrong balance) until a full pull. Read-only here; the fix is protected-surface work.',
  'Payment and Reminder carry no deleted flag at all, so their sync tombstone arrays are structurally always empty for every business.',
  'Debt.deleted is both the archive flag and the tombstone source, so archivedDebts and debtTombstones count the same rows by construction.',
  'No per-device sync cursor is stored server-side. newestWriteAt is the newest server-side write (max updatedAt across Customer, Debt and Payment), not evidence that any device has pulled it.',
];

@Injectable()
export class AdminSyncHealthService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /admin/sync-health - global tombstone totals + the known-limitation list + an
   * offset-paged per-business breakdown. Empty-safe end to end: no businesses and no
   * synced rows yield honest zeros, an empty page and null recency, never an error.
   */
  async overview(query: SyncHealthQueryDto): Promise<AdminSyncHealthView> {
    const page = query.page ?? 1;
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;

    const [totals, perBusiness] = await Promise.all([
      this.totals(),
      this.perBusiness(page, limit),
    ]);

    return { totals, knownLimitations: [...KNOWN_LIMITATIONS], perBusiness };
  }

  // --- internals -----------------------------------------------------------

  /** Tombstone counts across ALL businesses (not just the requested page). */
  private async totals(): Promise<AdminSyncTotalsView> {
    const [customerTombstones, deletedDebts] = await this.prisma.$transaction([
      this.prisma.customer.count({ where: { deleted: true } }),
      this.prisma.debt.count({ where: { deleted: true } }),
    ]);
    // One column, two readings: a deleted debt IS the archived debt the app lists.
    return { customerTombstones, debtTombstones: deletedDebts, archivedDebts: deletedDebts };
  }

  /**
   * Per-business breakdown, businessName asc (id tiebreak) so paging is stable.
   * Ordering by newestWriteAt is deliberately NOT offered: it is derived from three
   * tables after the page is drawn, so it cannot drive a correct SQL offset.
   */
  private async perBusiness(page: number, limit: number): Promise<Paged<AdminSyncBusinessView>> {
    const [total, businesses] = await this.prisma.$transaction([
      this.prisma.business.count(),
      this.prisma.business.findMany({
        select: { id: true, businessName: true },
        orderBy: [{ businessName: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const ids = businesses.map((b) => b.id);
    if (ids.length === 0) return { data: [], page, total };

    // Four grouped reads for the page, never a query per row.
    const [customerTombstones, debtTombstones, newestCustomer, newestDebt, newestPayment] =
      await Promise.all([
        this.prisma.customer.groupBy({
          by: ['businessId'],
          where: { businessId: { in: ids }, deleted: true },
          _count: { _all: true },
        }),
        this.prisma.debt.groupBy({
          by: ['businessId'],
          where: { businessId: { in: ids }, deleted: true },
          _count: { _all: true },
        }),
        this.prisma.customer.groupBy({
          by: ['businessId'],
          where: { businessId: { in: ids } },
          _max: { updatedAt: true },
        }),
        this.prisma.debt.groupBy({
          by: ['businessId'],
          where: { businessId: { in: ids } },
          _max: { updatedAt: true },
        }),
        this.prisma.payment.groupBy({
          by: ['businessId'],
          where: { businessId: { in: ids } },
          _max: { updatedAt: true },
        }),
      ]);

    const customerTombstoneBy = countMap(customerTombstones);
    const debtTombstoneBy = countMap(debtTombstones);
    const newestBy = new Map<string, Date>();
    for (const group of [...newestCustomer, ...newestDebt, ...newestPayment]) {
      const at = group._max.updatedAt;
      if (at === null) continue;
      const current = newestBy.get(group.businessId);
      if (current === undefined || at > current) newestBy.set(group.businessId, at);
    }

    const data = businesses.map((business) => ({
      businessId: business.id,
      businessName: business.businessName,
      customerTombstones: customerTombstoneBy.get(business.id) ?? 0,
      debtTombstones: debtTombstoneBy.get(business.id) ?? 0,
      newestWriteAt: newestBy.get(business.id)?.toISOString() ?? null,
    }));

    return { data, page, total };
  }
}

/** groupBy _count rows -> businessId => count, zero-filled by the caller. */
function countMap(groups: { businessId: string; _count: { _all: number } }[]): Map<string, number> {
  return new Map(groups.map((group) => [group.businessId, group._count._all]));
}
