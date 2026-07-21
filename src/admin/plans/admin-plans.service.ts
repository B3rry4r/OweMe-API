import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PLAN_ID_VALUES } from '../../shared';
import { AdminPlanView } from './admin-plans.views';

/** Row shape Prisma returns for the Plan model (only the columns this view needs). */
interface AdminPlanRow {
  id: string;
  name: string;
  pricePerMonth: number;
  creditsPerMonth: number;
  staffSeats: number;
  bvumCeiling: bigint | null;
}

/**
 * Admin-scoped read of the seeded Plan catalog (registry AdminPlansView). The app's
 * GET /plans sits behind the user guard and cross-rejects admin tokens by design, so
 * the dashboard gets its own projection here rather than reusing PlansService's
 * app-shaped Plan DTO. Reference data only - no tenant scope, no writes, no audit row.
 */
@Injectable()
export class AdminPlansService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /admin/plans - the whole catalog in fixed ladder order. */
  async list(): Promise<AdminPlanView[]> {
    const rows = (await this.prisma.plan.findMany({
      select: {
        id: true,
        name: true,
        pricePerMonth: true,
        creditsPerMonth: true,
        staffSeats: true,
        bvumCeiling: true,
      },
    })) as AdminPlanRow[];

    return rows
      .map((row) => this.toView(row))
      .sort((a, b) => a.planOrder - b.planOrder || a.planId.localeCompare(b.planId));
  }

  // --- internals -----------------------------------------------------------

  private toView(row: AdminPlanRow): AdminPlanView {
    return {
      planId: row.id,
      label: row.name,
      monthlyKobo: row.pricePerMonth,
      // BigInt column (rev 2 ceilings exceed 32-bit Int); serialized as number (< 2^53).
      ceilingKobo: row.bvumCeiling === null ? null : Number(row.bvumCeiling),
      // -1 is the storage sentinel for fair use; the dashboard contract is null.
      creditsPerMonth: row.creditsPerMonth === -1 ? null : row.creditsPerMonth,
      staffSeats: row.staffSeats,
      planOrder: this.planOrder(row.id),
    };
  }

  /**
   * Fixed ladder position. Unknown ids (a future tier seeded before this view knows
   * about it) sort after the canonical five instead of silently jumping the ladder.
   */
  private planOrder(planId: string): number {
    const index = (PLAN_ID_VALUES as readonly string[]).indexOf(planId);
    return index === -1 ? PLAN_ID_VALUES.length : index;
  }
}
