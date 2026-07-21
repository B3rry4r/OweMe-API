import { Injectable } from '@nestjs/common';
import type { BillingTransaction, Prisma, WebhookEventLog } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BUNDLE_CATALOG } from '../../billing/bundle-catalog';
import {
  BillingKind,
  EntitlementState,
  PAGINATION_DEFAULT_LIMIT,
} from '../../shared';
import {
  AdminBillingStatsView,
  AdminBillingTransactionView,
  AdminEntitlementStateCounts,
  AdminIapEventView,
  AdminIapLifecycleView,
  AdminSubscriptionView,
  Paged,
} from './admin-billing.views';
import {
  AdminBillingTransactionsQueryDto,
  AdminIapLifecycleQueryDto,
  AdminSubscriptionsQueryDto,
} from './dto/admin-billing.dto';

/**
 * Billing monitor reads (registry AdminBillingView). READ-ONLY by contract: the
 * subscription/entitlement machinery is the app's protected surface, so this service
 * only observes Subscription/BillingTransaction/Plan and the append-only
 * webhook_event_log. Nothing here writes, hence no audit rows.
 *
 * Honest-null policy (registry designNotes): source, storeFeeKobo, netKobo,
 * storeFeeMonthKobo and failedRenewalsThisMonth are null because no persisted field
 * or ruled derivation backs them yet - never an invented value.
 */
@Injectable()
export class AdminBillingService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /admin/billing/subscriptions - offset-paged entitlement roster, optional state filter. */
  async subscriptions(query: AdminSubscriptionsQueryDto): Promise<Paged<AdminSubscriptionView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;
    const where: Prisma.SubscriptionWhereInput = query.state
      ? { entitlementState: query.state }
      : {};

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.subscription.count({ where }),
      this.prisma.subscription.findMany({
        where,
        include: { business: { select: { businessName: true } } },
        orderBy: { businessId: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const priceByPlanId = await this.planPrices();
    return {
      data: rows.map((row) => ({
        businessId: row.businessId,
        businessName: row.business.businessName,
        plan: row.activePlanId,
        priceKobo: priceByPlanId.get(row.activePlanId) ?? 0,
        source: null,
        currentPeriodEnd: row.renewalAt ? row.renewalAt.toISOString() : null,
        state: row.entitlementState as EntitlementState,
      })),
      page,
      total,
    };
  }

  /** GET /admin/billing/transactions - offset-paged ledger for one month, newest first. */
  async transactions(
    query: AdminBillingTransactionsQueryDto,
  ): Promise<Paged<AdminBillingTransactionView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;
    const month = query.month ?? this.currentMonth();

    const where: Prisma.BillingTransactionWhereInput = { createdAt: this.monthRange(month) };
    if (query.search) {
      const matches = await this.prisma.business.findMany({
        where: { businessName: { contains: query.search } },
        select: { id: true },
      });
      where.OR = [
        { businessId: { in: matches.map((b) => b.id) } },
        { productId: { contains: query.search } },
        { kind: { contains: query.search } },
      ];
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.billingTransaction.count({ where }),
      this.prisma.billingTransaction.findMany({
        where,
        include: { business: { select: { businessName: true } } },
        // uuidv7 id desc tiebreaks same-millisecond rows in creation order.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const catalogPrice = await this.catalogPrices();
    return {
      data: rows.map((row) => this.toTransactionView(row, row.business.businessName, catalogPrice)),
      page,
      total,
    };
  }

  /** GET /admin/billing/stats - subscription counts + flat-plan MRR. */
  async stats(): Promise<AdminBillingStatsView> {
    const [counts, priceByPlanId] = await Promise.all([
      this.entitlementStateCounts(),
      this.planPrices(),
    ]);

    const active = await this.prisma.subscription.groupBy({
      by: ['activePlanId'],
      where: { entitlementState: 'active' },
      _count: { _all: true },
    });
    const mrrKobo = active.reduce(
      (sum, group) => sum + (priceByPlanId.get(group.activePlanId) ?? 0) * group._count._all,
      0,
    );

    return {
      activeSubscriptionCount: counts.active,
      graceSubscriptionCount: counts.gracePeriod,
      mrrKobo,
      storeFeeMonthKobo: null,
      failedRenewalsThisMonth: null,
    };
  }

  /**
   * GET /admin/billing/iap-lifecycle - entitlement census plus the store-driven
   * transitions feed. The census sweeps Subscription and works day one; the feed reads
   * webhook_event_log source 'iap' and is legitimately empty until the webhook
   * instrumentation task lands.
   */
  async iapLifecycle(query: AdminIapLifecycleQueryDto): Promise<AdminIapLifecycleView> {
    const page = query.page ?? 1;
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;
    const where: Prisma.WebhookEventLogWhereInput = { source: 'iap' };

    const [entitlementStateCounts, total, rows] = await Promise.all([
      this.entitlementStateCounts(),
      this.prisma.webhookEventLog.count({ where }),
      this.prisma.webhookEventLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const nameById = await this.businessNames(rows);
    return {
      entitlementStateCounts,
      events: { data: rows.map((row) => this.toEventView(row, nameById)), page, total },
    };
  }

  // --- internals -----------------------------------------------------------

  /** planId -> flat monthly price in kobo (Plan is the seeded catalog). */
  private async planPrices(): Promise<Map<string, number>> {
    const plans = await this.prisma.plan.findMany({ select: { id: true, pricePerMonth: true } });
    return new Map(plans.map((plan) => [plan.id, plan.pricePerMonth]));
  }

  /** store productId -> list price in kobo: plan products from Plan, bundles from the catalog. */
  private async catalogPrices(): Promise<Map<string, number>> {
    const plans = await this.prisma.plan.findMany({
      where: { productId: { not: null } },
      select: { productId: true, pricePerMonth: true },
    });
    const prices = new Map<string, number>(
      plans.map((plan) => [plan.productId as string, plan.pricePerMonth]),
    );
    for (const [productId, spec] of Object.entries(BUNDLE_CATALOG)) {
      prices.set(productId, spec.amountKobo);
    }
    return prices;
  }

  /** Every state key present with an honest zero, even on an empty Subscription table. */
  private async entitlementStateCounts(): Promise<AdminEntitlementStateCounts> {
    const groups = await this.prisma.subscription.groupBy({
      by: ['entitlementState'],
      _count: { _all: true },
    });
    const counts: AdminEntitlementStateCounts = {
      none: 0,
      pending: 0,
      active: 0,
      gracePeriod: 0,
      expired: 0,
    };
    for (const group of groups) {
      const state = group.entitlementState as EntitlementState;
      if (state in counts) counts[state] = group._count._all;
    }
    return counts;
  }

  /**
   * webhook_event_log carries no businessId column, so the name is resolved from the
   * retained detail payload when it names one; otherwise it stays null rather than guessed.
   */
  private async businessNames(rows: WebhookEventLog[]): Promise<Map<string, string>> {
    const ids = [
      ...new Set(rows.map((row) => this.detailBusinessId(row)).filter((id): id is string => id !== null)),
    ];
    if (ids.length === 0) return new Map();
    const businesses = await this.prisma.business.findMany({
      where: { id: { in: ids } },
      select: { id: true, businessName: true },
    });
    return new Map(businesses.map((b) => [b.id, b.businessName]));
  }

  private detailBusinessId(row: WebhookEventLog): string | null {
    if (row.detail === null || typeof row.detail !== 'object' || Array.isArray(row.detail)) {
      return null;
    }
    const businessId = (row.detail as Record<string, unknown>).businessId;
    return typeof businessId === 'string' ? businessId : null;
  }

  private toEventView(
    row: WebhookEventLog,
    businessNameById: Map<string, string>,
  ): AdminIapEventView {
    const businessId = this.detailBusinessId(row);
    return {
      id: row.id,
      at: row.createdAt.toISOString(),
      eventType: row.eventType,
      businessName: businessId === null ? null : businessNameById.get(businessId) ?? null,
      outcome: row.outcome as AdminIapEventView['outcome'],
      detail: row.detail === null ? null : (row.detail as object),
    };
  }

  private toTransactionView(
    row: BillingTransaction,
    businessName: string,
    catalogPrice: Map<string, number>,
  ): AdminBillingTransactionView {
    return {
      id: row.id,
      at: row.createdAt.toISOString(),
      businessName,
      kind: row.kind as BillingKind,
      sku: row.productId,
      grossKobo: row.amount,
      catalogPriceKobo: catalogPrice.get(row.productId) ?? null,
      storeFeeKobo: null,
      netKobo: null,
    };
  }

  /** Current UTC month as YYYY-MM (the transactions default). */
  private currentMonth(): string {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  /** [start, end) UTC bounds for a YYYY-MM month. */
  private monthRange(month: string): { gte: Date; lt: Date } {
    const [year, monthIndex] = month.split('-').map(Number);
    return {
      gte: new Date(Date.UTC(year, monthIndex - 1, 1)),
      lt: new Date(Date.UTC(year, monthIndex, 1)),
    };
  }
}
