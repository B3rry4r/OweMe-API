import { Injectable } from '@nestjs/common';
import type { Business, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BvumService } from '../../bvum/bvum.service';
import { MONTHLY_BUNDLE_CAP } from '../../billing/bundle-catalog';
import { currentPeriodStart } from '../../usage/period.util';
import { clampKobo, NotFoundAppException } from '../../common';
import {
  EntitlementState,
  PAGINATION_DEFAULT_LIMIT,
  PlanId,
  PLAN_ID_VALUES,
} from '../../shared';
import {
  AdminBusinessDebtsQueryDto,
  ADMIN_BUSINESS_DEBTS_DEFAULT_LIMIT,
  AdminBusinessListQueryDto,
} from './dto/admin-businesses.dto';
import {
  AdminBusinessDebtStatus,
  AdminBusinessDebtView,
  AdminBusinessDetailView,
  AdminBusinessStatus,
  AdminBusinessView,
  AdminCreditUsageView,
  Paged,
} from './admin-businesses.views';

/**
 * Admin reads over the LIVE Business tenant root (registry AdminBusinessesView).
 *
 * READ-ONLY by construction: every figure comes from a query or from BvumService
 * (a pure derived-read engine), never from the app's lazily-refilling credit path -
 * CreditLedgerService/UsageService would WRITE a refill as a side effect of an admin
 * page view, so the ledger row is read raw here and interpreted against the plan.
 * usage_events is empty until the fenced instrumentation task lands, so the per-type
 * credit meters render honest zeros rather than failing.
 */
@Injectable()
export class AdminBusinessesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bvum: BvumService,
  ) {}

  /** GET /admin/businesses - offset-paged, newest first, search + plan + status filters. */
  async list(query: AdminBusinessListQueryDto): Promise<Paged<AdminBusinessView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;

    const where: Prisma.BusinessWhereInput = {
      ...(query.search
        ? {
            OR: [
              { businessName: { contains: query.search } },
              { phone: { contains: query.search } },
            ],
          }
        : {}),
      ...(query.plan ? { plan: query.plan } : {}),
      ...this.statusWhere(query.status),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.business.count({ where }),
      this.prisma.business.findMany({
        where,
        // uuidv7 id desc tiebreaks same-millisecond rows in creation order.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const ids = rows.map((b) => b.id);
    const [ledgers, seatRows] = await Promise.all([
      this.prisma.creditLedger.findMany({ where: { businessId: { in: ids } } }),
      this.prisma.staff.findMany({
        where: { businessId: { in: ids }, role: { not: 'owner' }, active: true },
        select: { businessId: true },
      }),
    ]);
    const ledgerByBusiness = new Map(ledgers.map((l) => [l.businessId, l]));
    const seatsByBusiness = new Map<string, number>();
    for (const row of seatRows) {
      seatsByBusiness.set(row.businessId, (seatsByBusiness.get(row.businessId) ?? 0) + 1);
    }
    const planGrants = await this.planGrants();

    const data: AdminBusinessView[] = [];
    for (const business of rows) {
      // BvumService is the ONE definition of business value + effective ceiling; reusing it
      // keeps the admin table's bar consistent with what create-time enforcement compares.
      const snapshot = await this.bvum.compute(business.id);
      const ledger = ledgerByBusiness.get(business.id) ?? null;
      const grant = ledger?.monthlyGrant ?? planGrants.get(this.canonicalPlan(business.plan)) ?? 0;
      const fairUse = grant < 0;
      data.push({
        id: business.id,
        name: business.businessName,
        ownerPhoneMasked: maskPhone(business.phone),
        plan: this.canonicalPlan(business.plan),
        status: this.deriveStatus(business),
        isTest: business.isTest,
        suspendedAt: business.suspendedAt ? business.suspendedAt.toISOString() : null,
        bvumKobo: snapshot.value,
        ceilingKobo: snapshot.ceiling ?? 0,
        creditsUsed: fairUse ? null : Math.max(0, grant - (ledger?.balance ?? grant)),
        creditsGrant: fairUse ? null : grant,
        staffCount: seatsByBusiness.get(business.id) ?? 0,
        joinedAt: business.createdAt.toISOString(),
      });
    }

    return { data, page, total };
  }

  /** GET /admin/businesses/:id - the detail header (404 when the business is gone). */
  async detail(id: string): Promise<AdminBusinessDetailView> {
    const business = await this.requireBusiness(id);
    const plan = this.canonicalPlan(business.plan);

    const [planRow, subscription, seatsUsed, bundlesBoughtThisMonth, snapshot] = await Promise.all([
      this.prisma.plan.findUnique({ where: { id: plan } }),
      this.prisma.subscription.findUnique({ where: { businessId: id } }),
      this.prisma.staff.count({ where: { businessId: id, role: { not: 'owner' }, active: true } }),
      this.prisma.billingTransaction.count({
        where: { businessId: id, kind: 'credits-bundle', createdAt: { gte: currentPeriodStart() } },
      }),
      this.bvum.compute(id),
    ]);

    const baseCeilingKobo = planRow?.bvumCeiling === null ? 0 : Number(planRow?.bvumCeiling ?? 0);
    return {
      id: business.id,
      name: business.businessName,
      plan,
      isTest: business.isTest,
      suspendedAt: business.suspendedAt ? business.suspendedAt.toISOString() : null,
      ownerPhoneMasked: maskPhone(business.phone),
      joinedAt: business.createdAt.toISOString(),
      staffSeatsUsed: seatsUsed,
      staffSeatsTotal: planRow?.staffSeats ?? 0,
      subscriptionState: (subscription?.entitlementState as EntitlementState) ?? 'none',
      renewalAt: subscription?.renewalAt ? subscription.renewalAt.toISOString() : null,
      bvumKobo: snapshot.value,
      baseCeilingKobo,
      extraBands: business.enterpriseBands,
      effectiveCeilingKobo:
        business.bvumCeilingOverride !== null
          ? Number(business.bvumCeilingOverride)
          : baseCeilingKobo,
      bundlesBoughtThisMonth,
      bundleCapPerMonth: MONTHLY_BUNDLE_CAP,
    };
  }

  /**
   * GET /admin/businesses/:id/credit-usage - the unified OweMe-credits meter.
   * Per-type counts come from usage_events for the current ledger period and are all
   * zero until instrumentation lands; usedCredits falls back to the ledger derivation
   * (grant + bonus - balance) so the aggregate meter wires even from an empty table.
   */
  async creditUsage(id: string): Promise<AdminCreditUsageView> {
    const business = await this.requireBusiness(id);
    const [ledger, planRow] = await Promise.all([
      this.prisma.creditLedger.findUnique({ where: { businessId: id } }),
      this.prisma.plan.findUnique({ where: { id: this.canonicalPlan(business.plan) } }),
    ]);

    const grant = ledger?.monthlyGrant ?? planRow?.creditsPerMonth ?? 0;
    const fairUse = grant < 0;
    const balance = ledger?.balance ?? (fairUse ? 0 : grant);
    const periodStart = ledger?.periodStart ?? currentPeriodStart();

    const events = await this.prisma.usageEvent.groupBy({
      by: ['type'],
      where: { businessId: id, createdAt: { gte: periodStart } },
      _count: { _all: true },
      _sum: { credits: true },
    });
    const countOf = (type: string): number =>
      events.find((e) => e.type === type)?._count._all ?? 0;

    const bonusCredits = fairUse ? 0 : Math.max(0, balance - grant);
    const usedFromEvents = events.reduce((sum, e) => sum + (e._sum.credits ?? 0), 0);

    return {
      sends: countOf('send'),
      parses: countOf('voiceParse'),
      insights: countOf('insight'),
      // Fair use is unmetered against a grant, so only real events can be counted there.
      usedCredits: fairUse ? usedFromEvents : Math.max(0, grant + bonusCredits - balance),
      grant: fairUse ? null : grant,
      bonusCredits,
      fairUse,
      periodStart: periodStart.toISOString(),
    };
  }

  /** GET /admin/businesses/:id/debts - offset-paged debt panel, createdAt desc. */
  async debts(
    id: string,
    query: AdminBusinessDebtsQueryDto,
  ): Promise<Paged<AdminBusinessDebtView>> {
    await this.requireBusiness(id);
    const page = query.page ?? 1;
    const limit = query.limit ?? ADMIN_BUSINESS_DEBTS_DEFAULT_LIMIT;

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.debt.count({ where: { businessId: id } }),
      this.prisma.debt.findMany({
        where: { businessId: id },
        include: { customer: { select: { name: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const paidByDebt = await this.paidByDebt(rows.map((d) => d.id));
    const now = Date.now();
    const data = rows.map((row) => {
      const paid = paidByDebt.get(row.id) ?? 0;
      const remaining = clampKobo(row.amount - paid);
      return {
        id: row.id,
        customer: firstName(row.customer.name),
        amountKobo: row.amount,
        remainingKobo: remaining,
        status: this.deriveDebtStatus(row.deleted, remaining, row.dueDate, paid, now),
        createdAt: row.createdAt.toISOString(),
      };
    });

    return { data, page, total };
  }

  // --- internals -----------------------------------------------------------

  private async requireBusiness(id: string): Promise<Business> {
    const business = await this.prisma.business.findUnique({ where: { id } });
    if (!business) throw new NotFoundAppException('Business not found');
    return business;
  }

  /** Sum of payments per debt, in one grouped query (empty-safe). */
  private async paidByDebt(debtIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (debtIds.length === 0) return map;
    const grouped = await this.prisma.payment.groupBy({
      by: ['debtId'],
      where: { debtId: { in: debtIds } },
      _sum: { amount: true },
    });
    for (const g of grouped) map.set(g.debtId, g._sum.amount ?? 0);
    return map;
  }

  /** planId -> monthly credits grant, for businesses with no ledger row yet. */
  private async planGrants(): Promise<Map<PlanId, number>> {
    const plans = await this.prisma.plan.findMany({ select: { id: true, creditsPerMonth: true } });
    return new Map(plans.map((p) => [p.id as PlanId, p.creditsPerMonth]));
  }

  /** test > suspended > active, mirrored exactly by the status filter. */
  private deriveStatus(business: Business): AdminBusinessStatus {
    if (business.isTest) return 'test';
    if (business.suspendedAt !== null) return 'suspended';
    return 'active';
  }

  private statusWhere(status: AdminBusinessStatus | undefined): Prisma.BusinessWhereInput {
    switch (status) {
      case 'test':
        return { isTest: true };
      case 'suspended':
        return { isTest: false, suspendedAt: { not: null } };
      case 'active':
        return { isTest: false, suspendedAt: null };
      default:
        return {};
    }
  }

  /**
   * The live DebtsService derivation narrowed to the admin table's vocabulary:
   * soft-deleted rows read as archived, and the live reminder/scheduled/outstanding
   * buckets (which say nothing about money) collapse into open.
   */
  private deriveDebtStatus(
    deleted: boolean,
    remaining: number,
    dueDate: Date | null,
    paid: number,
    now: number,
  ): AdminBusinessDebtStatus {
    if (deleted) return 'archived';
    if (remaining <= 0) return 'paid';
    if (dueDate !== null && dueDate.getTime() < now) return 'overdue';
    if (paid > 0) return 'partial';
    return 'open';
  }

  /** Fail-closed to starter, exactly as the app does. */
  private canonicalPlan(plan: string | null | undefined): PlanId {
    return (PLAN_ID_VALUES as readonly string[]).includes(plan ?? '')
      ? (plan as PlanId)
      : 'starter';
  }
}

/** Owner phone masked server-side: only the last 4 digits ever leave the API. */
function maskPhone(phone: string): string {
  if (phone.length <= 4) return '*'.repeat(phone.length);
  return `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
}

/** First name only (the admin table never needs a customer's full identity). */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}
