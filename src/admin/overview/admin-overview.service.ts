import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanId, PLAN_ID_VALUES } from '../../shared';
import { currentPeriodStart } from '../../usage/period.util';
import { owemeCommissionKobo } from '../../debts/pay-link-fees';
import { OverviewActivityQueryDto } from './dto/admin-overview.dto';
import {
  AdminOverviewPlanCounts,
  AdminOverviewView,
  AdminPlatformEventTone,
  AdminPlatformEventView,
} from './admin-overview.views';

/** The app records pay-link settlements with this verbatim method label (webhooks.service.ts). */
const PAY_LINK_METHOD = 'Paystack link';

/** Sparkline width fixed by the dashboard contract: 12 trailing weeks, oldest first. */
const WEEKS = 12;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** One merged row of the read-time platform event union, before it becomes a view. */
interface EventRow {
  id: string;
  businessId: string;
  event: string;
  tone: AdminPlatformEventTone;
  at: Date;
}

/**
 * AdminOverview - platform-wide aggregates for the dashboard landing page.
 *
 * READ-ONLY over shipped tables. Every figure is derived at request time from live
 * rows; nothing is persisted and no lazily-refilling app service is invoked (reading
 * credits through UsageService would rewrite ledgers as a side effect of an admin
 * page view, so the ledger rows are read directly instead).
 *
 * Two figures are deliberately NOT computed here:
 *   - the enterprise band premium (25000 + 12500 x bands) is display-side per ruling,
 *     so only the raw band count total is returned alongside the flat-plan MRR;
 *   - pay-link commission is never persisted, so it is re-derived per payment through
 *     the live owemeCommissionKobo() formula (1% capped N500).
 */
@Injectable()
export class AdminOverviewService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /admin/overview - honest zeros on an empty platform. */
  async summary(): Promise<AdminOverviewView> {
    const now = new Date();
    const monthStart = currentPeriodStart(now);
    const weeksStart = this.weekStart(new Date(now.getTime() - (WEEKS - 1) * WEEK_MS));

    const [registeredBusinesses, bandsAggregate, planGroups, subscriptions, plans, ledgers] =
      await Promise.all([
        this.prisma.business.count(),
        this.prisma.business.aggregate({ _sum: { enterpriseBands: true } }),
        this.prisma.business.groupBy({ by: ['plan'], _count: { _all: true } }),
        this.prisma.subscription.findMany({
          where: { entitlementState: 'active', activePlanId: { not: 'starter' } },
          select: { activePlanId: true },
        }),
        this.prisma.plan.findMany({ select: { id: true, pricePerMonth: true } }),
        // Only ledgers already sitting in the current period: a stale row still carries
        // last period's balance and is refilled lazily on the trader's next read.
        this.prisma.creditLedger.findMany({
          where: { periodStart: { gte: monthStart }, monthlyGrant: { gte: 0 } },
          select: { monthlyGrant: true, balance: true },
        }),
      ]);

    // One pass over the trailing-12-week window covers both the weekly series and the
    // current-month pay-link figures (the month always starts inside that window).
    const payLinks = await this.prisma.payment.findMany({
      where: {
        method: PAY_LINK_METHOD,
        createdAt: { gte: weeksStart < monthStart ? weeksStart : monthStart },
      },
      select: { amount: true, createdAt: true },
    });

    const priceById = new Map(plans.map((p) => [p.id, p.pricePerMonth]));
    const mrrKobo = subscriptions.reduce(
      (sum, s) => sum + (priceById.get(s.activePlanId) ?? 0),
      0,
    );

    const creditsBurnedThisMonth = ledgers.reduce(
      (sum, l) => sum + Math.max(0, l.monthlyGrant - l.balance),
      0,
    );

    const weeklyRecoveredKobo = new Array<number>(WEEKS).fill(0);
    let recoveredThisMonthKobo = 0;
    let commissionThisMonthKobo = 0;
    for (const payment of payLinks) {
      if (payment.createdAt >= monthStart) {
        recoveredThisMonthKobo += payment.amount;
        commissionThisMonthKobo += owemeCommissionKobo(payment.amount);
      }
      const bucket = Math.floor(
        (this.weekStart(payment.createdAt).getTime() - weeksStart.getTime()) / WEEK_MS,
      );
      if (bucket >= 0 && bucket < WEEKS) weeklyRecoveredKobo[bucket] += payment.amount;
    }

    return {
      registeredBusinesses,
      activePaidSubscriptions: subscriptions.length,
      mrrKobo,
      enterpriseBandsTotal: bandsAggregate._sum.enterpriseBands ?? 0,
      creditsBurnedThisMonth,
      recoveredThisMonthKobo,
      commissionThisMonthKobo,
      weeklyRecoveredKobo,
      planCounts: this.planCounts(planGroups),
    };
  }

  /**
   * GET /admin/overview/activity - newest-first union view over the live domains.
   * Event kinds the fixture showed but nothing records yet (BVUM ceiling hit, payout
   * account verified) are omitted rather than faked; they arrive with instrumentation.
   */
  async activity(query: OverviewActivityQueryDto): Promise<AdminPlatformEventView[]> {
    const limit = query.limit ?? 10;

    // Each source contributes at most `limit` rows: the merged top `limit` cannot
    // contain more than that from any one of them.
    const [businesses, billing, payLinks] = await Promise.all([
      this.prisma.business.findMany({
        select: { id: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      }),
      this.prisma.billingTransaction.findMany({
        where: { kind: { in: ['subscription', 'credits-bundle'] } },
        select: { id: true, businessId: true, kind: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      }),
      this.prisma.payment.findMany({
        where: { method: PAY_LINK_METHOD },
        select: { id: true, businessId: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      }),
    ]);

    const rows: EventRow[] = [
      ...businesses.map((b) => ({
        id: `business-${b.id}`,
        businessId: b.id,
        event: 'Business registered',
        tone: 'neutral' as const,
        at: b.createdAt,
      })),
      ...billing.map((t) => ({
        id: `billing-${t.id}`,
        businessId: t.businessId,
        event: t.kind === 'subscription' ? 'Subscription payment' : 'Credit bundle purchased',
        tone: (t.kind === 'subscription' ? 'brand' : 'gold') as AdminPlatformEventTone,
        at: t.createdAt,
      })),
      ...payLinks.map((p) => ({
        id: `payment-${p.id}`,
        businessId: p.businessId,
        event: 'Pay link recovery',
        tone: 'info' as const,
        at: p.createdAt,
      })),
    ];

    rows.sort((a, b) => b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id));
    const page = rows.slice(0, limit);

    const nameById = await this.businessNames(page);
    return page.map((row) => ({
      id: row.id,
      business: nameById.get(row.businessId) ?? 'Unknown business',
      event: row.event,
      tone: row.tone,
      at: row.at.toISOString(),
    }));
  }

  // --- internals -----------------------------------------------------------

  /** All five ladder tiers always present, zero-filled (registry planCounts shape). */
  private planCounts(
    groups: { plan: string; _count: { _all: number } }[],
  ): AdminOverviewPlanCounts {
    const counts = Object.fromEntries(PLAN_ID_VALUES.map((id) => [id, 0])) as Record<
      PlanId,
      number
    >;
    for (const group of groups) {
      // Unknown/legacy plan strings fail closed to starter, matching plan-grants.ts.
      const plan = (PLAN_ID_VALUES as readonly string[]).includes(group.plan)
        ? (group.plan as PlanId)
        : 'starter';
      counts[plan] += group._count._all;
    }
    return counts;
  }

  /** Monday 00:00 UTC of the week containing `at` (ISO week boundaries). */
  private weekStart(at: Date): Date {
    const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    // getUTCDay(): 0 = Sunday, so Sunday belongs to the week that began six days earlier.
    const offset = (day.getUTCDay() + 6) % 7;
    return new Date(day.getTime() - offset * 24 * 60 * 60 * 1000);
  }

  private async businessNames(rows: EventRow[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((r) => r.businessId))];
    if (ids.length === 0) return new Map();
    const businesses = await this.prisma.business.findMany({
      where: { id: { in: ids } },
      select: { id: true, businessName: true },
    });
    return new Map(businesses.map((b) => [b.id, b.businessName]));
  }
}
