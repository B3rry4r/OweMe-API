import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BvumResponse, PlanId, PLAN_ID_VALUES } from '../shared';
import { clampKobo, BvumCeilingException } from '../common';

/** Observation window for the BVUM computation (30 days). */
const WINDOW_DAYS = 30;

/** Weighted BVUM signals (FRONTEND-HANDOFF.md §4). Sum = 1.0. */
const WEIGHTS = {
  receivables: 0.4, // outstanding receivables (sum remaining)
  creditIssued: 0.3, // monthly credit issued (debts created in window)
  recovery: 0.15, // recovery volume (payments in window)
  activeDebtors: 0.1, // active debtors (structural)
  complexity: 0.05, // portfolio complexity (structural)
} as const;

/** Fraction of the ceiling at/above which GET /bvum surfaces an upgrade recommendation. */
const RECOMMEND_AT = 0.8;

/** Canonical plan order (rev 2, 5 tiers) — ascending ceilings. */
const PLAN_ORDER: PlanId[] = [...PLAN_ID_VALUES];

/** Minimal debt shape the value computation needs (incl. a hypothetical to-be-created debt). */
interface DebtLite {
  amount: number;
  createdAt: Date;
  customerId: string;
  payments: { amount: number; createdAt: Date }[];
}

/**
 * BvumService — "Business Value Under Management" engine (bvum-engine declaration), MODEL REV 2.
 *
 * Two roles:
 *   1. GET /bvum — advisory snapshot (value, effective ceiling, upgrade recommendation).
 *   2. INSTANT ENFORCEMENT — `assertDebtWithinCeiling` is called by DebtsService.create and
 *      throws 403 BVUM_CEILING (no grace window) when a NEW debt would breach the plan's
 *      effective ceiling. Existing debts, payments, reminders, and everything
 *      collection-related are NEVER blocked — growth is gated, recovery is not.
 *
 * Ceilings are concrete for every tier; enterprise is BANDED (base ₦40M + sales-provisioned
 * Business.bvumCeilingOverride), never unlimited/null.
 */
@Injectable()
export class BvumService {
  constructor(private readonly prisma: PrismaService) {}

  async compute(businessId: string): Promise<BvumResponse> {
    const debts = await this.loadDebts(businessId);
    const value = computeValue(debts);
    const { ceiling, plan } = await this.resolveCeiling(businessId);
    const recommendedPlan = await this.recommend(plan, ceiling, value);
    return { value, ceiling, recommendedPlan, windowDays: WINDOW_DAYS };
  }

  /**
   * Instant enforcement. Throws 403 BVUM_CEILING (requiredPlan = the tier that covers the
   * new value) when creating a debt of `amountKobo` for `customerId` would push BVUM above
   * the business's effective ceiling. No-op when it stays within the ceiling.
   */
  async assertDebtWithinCeiling(
    businessId: string,
    amountKobo: number,
    customerId: string,
  ): Promise<void> {
    const debts = await this.loadDebts(businessId);
    const projected = computeValue([
      ...debts,
      { amount: amountKobo, createdAt: new Date(), customerId, payments: [] },
    ]);
    const { ceiling } = await this.resolveCeiling(businessId);
    if (ceiling === null) return; // defensive: rev 2 ceilings are never null, but never block if so
    if (projected > ceiling) {
      throw new BvumCeilingException(await this.requiredPlanFor(projected));
    }
  }

  private async loadDebts(businessId: string): Promise<DebtLite[]> {
    const rows = await this.prisma.debt.findMany({
      where: { businessId, deleted: false },
      include: { payments: true },
    });
    return rows as unknown as DebtLite[];
  }

  /**
   * Effective ceiling = the business's sales-provisioned `bvumCeilingOverride` (enterprise
   * banding) when set, else the plan's base ceiling. Fail CLOSED to starter if plan/row missing.
   */
  private async resolveCeiling(
    businessId: string,
  ): Promise<{ ceiling: number | null; plan: PlanId }> {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    const plan = this.canonicalPlan(business?.plan);
    const planRow = await this.prisma.plan.findUnique({ where: { id: plan } });
    // bvumCeiling / bvumCeilingOverride are BigInt columns (ceilings exceed 32-bit Int);
    // convert to number for comparison against the (number) BVUM value.
    const ceilingBig = business?.bvumCeilingOverride ?? planRow?.bvumCeiling ?? null;
    const ceiling = ceilingBig === null ? null : Number(ceilingBig);
    return { ceiling, plan };
  }

  /** Smallest plan whose ceiling covers `value`; enterprise (banded, expandable) if none do. */
  private async requiredPlanFor(value: number): Promise<PlanId> {
    const plans = await this.prisma.plan.findMany();
    for (const id of PLAN_ORDER) {
      const row = plans.find((p) => p.id === id);
      if (row && row.bvumCeiling !== null && Number(row.bvumCeiling) >= value) return id;
    }
    return 'enterprise'; // banded — a new ₦20M band expands to fit
  }

  /**
   * Advisory upgrade recommendation for GET /bvum: when value nears/exceeds the ceiling
   * (fraction >= 0.8), the next plan up whose ceiling is higher. null otherwise. Never mutates.
   */
  private async recommend(
    plan: PlanId,
    ceiling: number | null,
    value: number,
  ): Promise<PlanId | null> {
    if (ceiling === null || ceiling <= 0) return null;
    if (value / ceiling < RECOMMEND_AT) return null;

    const plans = await this.prisma.plan.findMany();
    const ceilingOf = (id: PlanId): number | null => {
      const row = plans.find((p) => p.id === id);
      return row && row.bvumCeiling !== null ? Number(row.bvumCeiling) : null;
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

/** Pure BVUM value (kobo) over a set of non-deleted debts across the 30-day window. */
function computeValue(debts: DebtLite[]): number {
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  let receivables = 0;
  let creditIssued = 0;
  let recovery = 0;
  let totalPrincipal = 0;
  let openDebts = 0;
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
  const avgTicket = debts.length > 0 ? Math.round(totalPrincipal / debts.length) : 0;

  return Math.round(
    WEIGHTS.receivables * receivables +
      WEIGHTS.creditIssued * creditIssued +
      WEIGHTS.recovery * recovery +
      WEIGHTS.activeDebtors * (activeDebtors * avgTicket) +
      WEIGHTS.complexity * (openDebts * avgTicket),
  );
}
