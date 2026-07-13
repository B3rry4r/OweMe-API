import { PlanId, PLAN_ID_VALUES } from '../shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Per-plan monthly grants used to (re)fill a business's ledgers. Values ultimately come
 * from the seeded Plan table (limitsFor(plan)); -1 = fair-use (unmetered, never blocks).
 * Fail-closed to starter grants when the business/plan cannot be resolved (conventions §Entitlements).
 */
export interface PlanGrants {
  planId: PlanId;
  sendsPerMonth: number; // -1 fair-use
  aiCreditsPerMonth: number; // -1 fair-use
}

/** Fail-closed default (starter) if the Plan catalog is unseeded/unknown. */
const STARTER_FALLBACK: PlanGrants = { planId: 'starter', sendsPerMonth: 10, aiCreditsPerMonth: 10 };

/** Resolve the current monthly grants for a business from its plan (server-authoritative). */
export async function resolvePlanGrants(
  prisma: PrismaService,
  businessId: string,
): Promise<PlanGrants> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { plan: true },
  });
  const planId = (business?.plan ?? 'starter') as string;

  const plan =
    (await prisma.plan.findUnique({ where: { id: planId } })) ??
    (await prisma.plan.findUnique({ where: { id: 'starter' } }));

  if (!plan) return STARTER_FALLBACK;

  return {
    planId: plan.id as PlanId,
    sendsPerMonth: plan.sendsPerMonth,
    aiCreditsPerMonth: plan.aiCreditsPerMonth,
  };
}

/**
 * Upgrade recommendation surfaced in PLAN_REQUIRED responses: the next tier above the
 * caller's current plan (clamped at enterprise). Never auto-changes the plan.
 */
export function nextPlanId(current: string): string {
  const order: readonly PlanId[] = PLAN_ID_VALUES;
  const i = order.indexOf(current as PlanId);
  if (i < 0) return 'market';
  return order[Math.min(i + 1, order.length - 1)];
}
