import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PAGINATION_DEFAULT_LIMIT, PLAN_ID_VALUES, PlanId } from '../../shared';
import { BUNDLE_CATALOG, MONTHLY_BUNDLE_CAP } from '../../billing/bundle-catalog';
import { CREDIT_WEIGHTS } from '../../usage/credit-ledger.service';
import { currentPeriodStart } from '../../usage/period.util';
import {
  BundlePurchasesQueryDto,
  HEAVY_USERS_DEFAULT_LIMIT,
  HeavyUsersQueryDto,
} from './dto/admin-credits.dto';
import {
  AdminBundlePurchaseView,
  AdminBurnByTypeView,
  AdminBurnType,
  AdminCreditsConfigView,
  AdminCreditsStatsView,
  AdminHeavyUserView,
  AdminPlanGrantView,
  Paged,
} from './admin-credits.views';

/**
 * Read-only credits monitor (registry AdminCreditsView). Reads the live rev 2 unified
 * OweMe-credits surfaces - CreditLedger, BillingTransaction, Plan - plus the append-only
 * usage_events table, which is populated by a LATER instrumentation task: every read here
 * is empty-safe and renders honest zeros / empty arrays from a zero-row database.
 *
 * Derivations (registry designNotes):
 *   granted  = sum of current-period ledger grants, fair-use (-1) excluded.
 *   used     = grant + bundle credits bought this month - balance (clamped at 0); for
 *              fair-use ledgers, which are unmetered and carry no balance arithmetic,
 *              used comes from usage_events (0 until instrumented).
 *   burned   = sum of used across the current-period ledgers.
 * Ledgers whose periodStart predates the current month have not been touched (read/debit)
 * this month; they hold last month's residue, so they are outside the month's derivation.
 */
@Injectable()
export class AdminCreditsService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /admin/credits/stats - platform-wide month summary + per-type burn. */
  async stats(): Promise<AdminCreditsStatsView> {
    const period = currentPeriodStart();
    const rows = await this.usageRows(period);

    return {
      grantedThisMonth: rows.reduce((sum, row) => sum + (row.grant ?? 0), 0),
      burnedThisMonth: rows.reduce((sum, row) => sum + row.used, 0),
      monthLabel: monthLabelOf(period),
      burnByType: await this.burnByType(period),
    };
  }

  /** GET /admin/credits/heavy-users - offset-paged, ranked by credits used descending. */
  async heavyUsers(query: HeavyUsersQueryDto): Promise<Paged<AdminHeavyUserView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? HEAVY_USERS_DEFAULT_LIMIT;

    const rows = (await this.usageRows(currentPeriodStart())).filter(
      (row) => query.plan === undefined || row.plan === query.plan,
    );
    // Rank on the derived figure, so the slice happens after sorting (names break ties).
    rows.sort((a, b) => b.used - a.used || a.businessName.localeCompare(b.businessName));

    return {
      data: rows.slice((page - 1) * limit, (page - 1) * limit + limit),
      page,
      total: rows.length,
    };
  }

  /** GET /admin/credits/bundle-purchases - month-scoped top-up history, newest first. */
  async bundlePurchases(
    query: BundlePurchasesQueryDto,
  ): Promise<Paged<AdminBundlePurchaseView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;
    const where = {
      kind: 'credits-bundle',
      createdAt: query.month ? monthRange(query.month) : { gte: currentPeriodStart() },
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.billingTransaction.count({ where }),
      this.prisma.billingTransaction.findMany({
        where,
        // uuidv7 id desc tiebreaks same-millisecond rows in creation order.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: { business: { select: { businessName: true } } },
      }),
    ]);

    return {
      data: rows.map((row) => ({
        id: row.id,
        purchasedAt: row.createdAt.toISOString(),
        businessName: row.business.businessName,
        sku: row.productId,
        credits: bundleCredits(row.productId),
        // Webhook-recorded rows carry amount 0 (protected registry), so the catalog is the
        // price of record; an unknown SKU falls back to a recorded amount, else null.
        priceKobo:
          BUNDLE_CATALOG[row.productId]?.amountKobo ?? (row.amount > 0 ? row.amount : null),
      })),
      page,
      total,
    };
  }

  /**
   * GET /admin/credits/config - the constants the dashboard must never hardcode:
   * bundle cap, CREDIT_WEIGHTS, the SKU catalog and the seeded per-plan grants.
   */
  async config(): Promise<AdminCreditsConfigView> {
    const plans = await this.prisma.plan.findMany({ select: { id: true, creditsPerMonth: true } });
    const grants: AdminPlanGrantView[] = plans
      .map((plan) => ({
        planId: plan.id as PlanId,
        creditsPerMonth: plan.creditsPerMonth === -1 ? null : plan.creditsPerMonth,
      }))
      .sort((a, b) => planOrder(a.planId) - planOrder(b.planId));

    return {
      bundleCapPerMonth: MONTHLY_BUNDLE_CAP,
      creditWeights: {
        send: CREDIT_WEIGHTS.reminderSend,
        voiceParse: CREDIT_WEIGHTS.voiceParse,
        insightOrRisk: CREDIT_WEIGHTS.insightOrRisk,
      },
      bundles: Object.entries(BUNDLE_CATALOG)
        .map(([sku, spec]) => ({ sku, credits: spec.quantity, priceKobo: spec.amountKobo }))
        .sort((a, b) => a.credits - b.credits),
      planGrants: grants,
      fairUseNote:
        'Enterprise runs on fair use: credits are unmetered and never block sending, ' +
        'subject to reasonable-use review.',
    };
  }

  // --- internals -----------------------------------------------------------

  /**
   * One pass over the current period's ledgers with the per-business derivations the
   * stats card and the heaviest-users table both need. Empty ledger table -> [].
   */
  private async usageRows(period: Date): Promise<AdminHeavyUserView[]> {
    const ledgers = await this.prisma.creditLedger.findMany({
      where: { periodStart: { gte: period } },
      include: { business: { select: { businessName: true, plan: true } } },
    });
    if (ledgers.length === 0) return [];

    const bundles = await this.prisma.billingTransaction.findMany({
      where: { kind: 'credits-bundle', createdAt: { gte: period } },
      select: { businessId: true, productId: true },
    });
    const bundleCount = new Map<string, number>();
    const bundleCreditsBought = new Map<string, number>();
    for (const row of bundles) {
      bundleCount.set(row.businessId, (bundleCount.get(row.businessId) ?? 0) + 1);
      bundleCreditsBought.set(
        row.businessId,
        (bundleCreditsBought.get(row.businessId) ?? 0) + bundleCredits(row.productId),
      );
    }

    // Fair-use ledgers carry no balance arithmetic; their burn is only knowable from events.
    const events = await this.prisma.usageEvent.groupBy({
      by: ['businessId'],
      where: { createdAt: { gte: period } },
      _sum: { credits: true },
    });
    const eventCredits = new Map(events.map((e) => [e.businessId, e._sum.credits ?? 0]));

    return ledgers.map((ledger) => {
      const fairUse = ledger.monthlyGrant === -1;
      const bonus = bundleCreditsBought.get(ledger.businessId) ?? 0;
      return {
        businessId: ledger.businessId,
        businessName: ledger.business.businessName,
        plan: ledger.business.plan,
        grant: fairUse ? null : ledger.monthlyGrant,
        fairUse,
        used: fairUse
          ? eventCredits.get(ledger.businessId) ?? 0
          : Math.max(0, ledger.monthlyGrant + bonus - ledger.balance),
        bundlesThisMonth: bundleCount.get(ledger.businessId) ?? 0,
      };
    });
  }

  /**
   * Burn grouped by event type for the month. usage_events is empty until the fenced
   * instrumentation task lands, which is exactly the dashboard's honest empty state.
   */
  private async burnByType(period: Date): Promise<AdminBurnByTypeView[]> {
    const grouped = await this.prisma.usageEvent.groupBy({
      by: ['type'],
      where: { createdAt: { gte: period } },
      _count: { _all: true },
      _sum: { credits: true },
    });
    if (grouped.length === 0) return [];

    const byType = new Map(grouped.map((row) => [row.type, row]));
    return BURN_TYPES.filter((spec) => byType.has(spec.type)).map((spec) => {
      const row = byType.get(spec.type)!;
      return {
        type: spec.type,
        label: spec.label,
        creditsPerEvent: spec.creditsPerEvent,
        events: row._count._all,
        credits: row._sum.credits ?? 0,
      };
    });
  }
}

/** Metered types in dashboard order, weighted from CREDIT_WEIGHTS (the code truth). */
const BURN_TYPES: readonly { type: AdminBurnType; label: string; creditsPerEvent: number }[] = [
  { type: 'send', label: 'Reminder sends', creditsPerEvent: CREDIT_WEIGHTS.reminderSend },
  { type: 'voiceParse', label: 'Voice parses', creditsPerEvent: CREDIT_WEIGHTS.voiceParse },
  { type: 'insight', label: 'AI insights', creditsPerEvent: CREDIT_WEIGHTS.insightOrRisk },
];

/** Credits a bundle SKU grants: catalog first, then the oweme_credits_<n> pattern, else 0. */
function bundleCredits(productId: string): number {
  const spec = BUNDLE_CATALOG[productId];
  if (spec) return spec.quantity;
  const match = /^oweme_credits_(\d+)$/.exec(productId);
  return match ? Number(match[1]) : 0;
}

/** YYYY-MM label for a period start (UTC). */
function monthLabelOf(period: Date): string {
  return `${period.getUTCFullYear()}-${String(period.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** [start, end) UTC bounds for a YYYY-MM month. */
function monthRange(month: string): { gte: Date; lt: Date } {
  const [year, monthIndex] = month.split('-').map(Number);
  return {
    gte: new Date(Date.UTC(year, monthIndex - 1, 1)),
    lt: new Date(Date.UTC(year, monthIndex, 1)),
  };
}

/** Canonical ladder order (starter -> enterprise) for the config plan grants. */
function planOrder(planId: PlanId): number {
  const index = PLAN_ID_VALUES.indexOf(planId);
  return index < 0 ? PLAN_ID_VALUES.length : index;
}
