import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BvumResponse, PlanId, PLAN_ID_VALUES } from '../shared';
import { clampKobo } from '../common';

/** Observation window for the BVUM computation (conventions §Metering — 30 days). */
const WINDOW_DAYS = 30;

/** Weighted BVUM signals (conventions §Metering). Sum = 1.0. */
const WEIGHTS = {
  receivables: 0.4, // outstanding receivables (sum remaining)
  creditIssued: 0.3, // monthly credit issued (debts created in window)
  recovery: 0.15, // recovery volume (payments in window)
  activeDebtors: 0.1, // active debtors (structural)
  complexity: 0.05, // portfolio complexity (structural)
} as const;

/** Fraction of the ceiling at/above which we surface an upgrade RECOMMENDATION. */
const RECOMMEND_AT = 0.8;

/** Canonical plan order (S-3) — used to pick the "next plan up". */
const PLAN_ORDER: PlanId[] = [...PLAN_ID_VALUES];

/**
 * BvumService — "Business Value Under Management" engine (bvum-engine declaration).
 *
 * Computes a single kobo value over the tenant's non-deleted debts across a rolling
 * 30-day observation window, blending five weighted signals, then compares it to the
 * business plan's bvumCeiling to (optionally) surface an upgrade RECOMMENDATION.
 *
 * RECOMMENDATION ONLY — this service NEVER mutates Business.plan (or any row).
 */
@Injectable()
export class BvumService {
  constructor(private readonly prisma: PrismaService) {}

  async compute(businessId: string): Promise<BvumResponse> {
    const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

    // Read-only: the tenant's non-deleted debts + their payments.
    const debts = await this.prisma.debt.findMany({
      where: { businessId, deleted: false },
      include: { payments: true },
    });

    let receivables = 0; // Σ remaining (all non-deleted debts)
    let creditIssued = 0; // Σ amount for debts created within the window
    let recovery = 0; // Σ payment.amount within the window
    let totalPrincipal = 0; // Σ amount (for average ticket)
    let openDebts = 0; // debts with remaining > 0 (complexity)
    const activeCustomers = new Set<string>();

    for (const debt of debts) {
      const paid = debt.payments.reduce((sum, p) => sum + p.amount, 0);
      const remaining = clampKobo(debt.amount - paid);

      receivables += remaining;
      totalPrincipal += debt.amount;

      if (debt.createdAt >= windowStart) creditIssued += debt.amount;

      for (const p of debt.payments) {
        if (p.createdAt >= windowStart) recovery += p.amount;
      }

      if (remaining > 0) {
        openDebts += 1;
        activeCustomers.add(debt.customerId);
      }
    }

    const activeDebtors = activeCustomers.size;
    // Average ticket expresses the structural (count) signals in kobo terms.
    const avgTicket = debts.length > 0 ? Math.round(totalPrincipal / debts.length) : 0;

    const value = Math.round(
      WEIGHTS.receivables * receivables +
        WEIGHTS.creditIssued * creditIssued +
        WEIGHTS.recovery * recovery +
        WEIGHTS.activeDebtors * (activeDebtors * avgTicket) +
        WEIGHTS.complexity * (openDebts * avgTicket),
    );

    const { ceiling, plan } = await this.resolveCeiling(businessId);
    const recommendedPlan = await this.recommend(plan, ceiling, value);

    return { value, ceiling, recommendedPlan, windowDays: WINDOW_DAYS };
  }

  /** Ceiling = the business plan's bvumCeiling. Fail CLOSED to starter if plan/row missing. */
  private async resolveCeiling(
    businessId: string,
  ): Promise<{ ceiling: number | null; plan: PlanId }> {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    const plan = this.canonicalPlan(business?.plan);
    const planRow = await this.prisma.plan.findUnique({ where: { id: plan } });
    // bvumCeiling is null for unlimited (enterprise); undefined (no row) -> unlimited too.
    const ceiling = planRow ? planRow.bvumCeiling : null;
    return { ceiling, plan };
  }

  /**
   * Upgrade RECOMMENDATION: when value nears/exceeds the ceiling (fraction >= 0.8), the next
   * plan up whose ceiling is higher (or unlimited). null otherwise — and ALWAYS null on an
   * unlimited (enterprise) ceiling. Never mutates the plan.
   */
  private async recommend(
    plan: PlanId,
    ceiling: number | null,
    value: number,
  ): Promise<PlanId | null> {
    if (ceiling === null || ceiling <= 0) return null; // unlimited or unknown -> no recommendation
    if (value / ceiling < RECOMMEND_AT) return null;

    const plans = await this.prisma.plan.findMany();
    const ceilingOf = (id: PlanId): number | null => {
      const row = plans.find((p) => p.id === id);
      return row ? row.bvumCeiling : null;
    };

    const startIdx = PLAN_ORDER.indexOf(plan);
    for (let i = startIdx + 1; i < PLAN_ORDER.length; i++) {
      const candidateId = PLAN_ORDER[i];
      const candidateCeiling = ceilingOf(candidateId);
      if (candidateCeiling === null || candidateCeiling > ceiling) return candidateId;
    }
    return null; // already at the top ceiling
  }

  private canonicalPlan(plan: string | undefined | null): PlanId {
    return (PLAN_ID_VALUES as readonly string[]).includes(plan ?? '')
      ? (plan as PlanId)
      : 'starter';
  }
}
