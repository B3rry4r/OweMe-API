import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { clampKobo } from '../../common';
import { PrismaService } from '../../prisma/prisma.service';
import { PAGINATION_DEFAULT_LIMIT } from '../../shared';
import { AdminDebtsQueryDto, AdminPaymentsQueryDto } from './dto/admin-debts.dto';
import {
  AdminDebtStatsView,
  AdminDebtStatus,
  AdminDebtView,
  AdminPaymentView,
  Paged,
} from './admin-debts.views';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Payment timestamps needed to derive money + the settling payment, ordered oldest first. */
interface PaymentFacts {
  paidKobo: number;
  /** createdAt of the payment that first covered the principal; null while unpaid. */
  settledAt: Date | null;
}

/**
 * Cross-tenant debt + payment reads for the admin dashboard (registry AdminDebtsView).
 * READ-ONLY: this service never writes, and it queries the protected Debt/Payment/
 * Reminder/Business/Customer tables directly rather than importing the tenant-scoped
 * app services (those require a JWT businessId by design).
 *
 * Money and status are DERIVED exactly as the live app derives them:
 *   paidKobo      = sum(payments.amount)
 *   remainingKobo = clamp(amount - paidKobo)
 *   status        = archived|paid|overdue|partial|open (see admin-debts.views.ts)
 * Nothing here is stored. Because status is derived, the status filter is applied
 * over the derived rows after a DB-level narrowing (deleted flag + search), which
 * mirrors the live DebtsService.list idiom; `total` is the filtered row count.
 */
@Injectable()
export class AdminDebtsService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /admin/debts - offset-paged, newest first, empty-table graceful. */
  async list(query: AdminDebtsQueryDto): Promise<Paged<AdminDebtView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;

    // Archived is the only status that lives in a column; every other status is
    // derived, so the DB narrowing is limited to the delete flag and the search.
    const where: Prisma.DebtWhereInput = { deleted: query.status === 'archived' };
    const search = query.search?.trim();
    if (search) {
      where.OR = [
        { business: { businessName: { contains: search } } },
        { customer: { name: { contains: search } } },
      ];
    }

    const rows = await this.prisma.debt.findMany({
      where,
      include: {
        business: { select: { businessName: true } },
        customer: { select: { name: true, phone: true } },
      },
      // uuidv7 id desc tiebreaks same-millisecond rows in creation order.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const principalById = new Map(rows.map((r) => [r.id, r.amount]));
    const [payments, reminderCounts] = await Promise.all([
      this.paymentFactsByDebt(principalById),
      this.reminderCountByDebt(rows.map((r) => r.id)),
    ]);

    const now = Date.now();
    let views = rows.map((row) =>
      this.toDebtView(
        row,
        payments.get(row.id) ?? { paidKobo: 0, settledAt: null },
        reminderCounts.get(row.id) ?? 0,
        now,
      ),
    );
    if (query.status && query.status !== 'archived') {
      views = views.filter((v) => v.status === query.status);
    }

    const total = views.length;
    const data = views.slice((page - 1) * limit, (page - 1) * limit + limit);
    return { data, page, total };
  }

  /**
   * GET /admin/debts/stats - recovery aggregates over the live rows.
   * The month window is the CURRENT calendar month resolved server-side at call
   * time (UTC bounds), never a hardcoded prefix. Archived debts are excluded from
   * the debt-shaped figures; recovered-this-month counts every payment received in
   * the window because that money was received regardless of the debt's later fate.
   */
  async stats(): Promise<AdminDebtStatsView> {
    const now = new Date();
    const rows = await this.prisma.debt.findMany({
      where: { deleted: false },
      select: { id: true, amount: true, dueDate: true, createdAt: true },
    });
    const payments = await this.paymentFactsByDebt(new Map(rows.map((r) => [r.id, r.amount])));

    let openRemainingKobo = 0;
    let overdueDebtCount = 0;
    const recoveryDays: number[] = [];
    for (const row of rows) {
      const facts = payments.get(row.id) ?? { paidKobo: 0, settledAt: null };
      const remaining = clampKobo(row.amount - facts.paidKobo);
      if (remaining > 0) {
        openRemainingKobo += remaining;
        if (row.dueDate !== null && row.dueDate.getTime() < now.getTime()) overdueDebtCount += 1;
      } else if (facts.settledAt !== null) {
        recoveryDays.push(this.daysBetween(row.createdAt, facts.settledAt));
      }
    }

    const recovered = await this.prisma.payment.aggregate({
      where: { createdAt: this.currentMonthRange(now) },
      _sum: { amount: true },
    });

    return {
      openRemainingKobo,
      recoveredThisMonthKobo: recovered._sum.amount ?? 0,
      overdueDebtCount,
      avgDaysToRecovery:
        recoveryDays.length === 0
          ? null
          : Math.round((recoveryDays.reduce((a, b) => a + b, 0) / recoveryDays.length) * 10) / 10,
    };
  }

  /** GET /admin/payments - offset-paged recent payments feed, newest first. */
  async payments(query: AdminPaymentsQueryDto): Promise<Paged<AdminPaymentView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.payment.count(),
      this.prisma.payment.findMany({
        include: { business: { select: { businessName: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      data: rows.map((row) => ({
        id: row.id,
        businessName: row.business.businessName,
        amountKobo: row.amount,
        // Verbatim: 'Paystack link' plus whatever free-text label the client recorded.
        method: row.method,
        paidAt: row.createdAt.toISOString(),
      })),
      page,
      total,
    };
  }

  // --- internals -----------------------------------------------------------

  /**
   * Paid total + settling-payment timestamp per debt in one query. The settling
   * payment is the oldest payment at which the cumulative total first covers the
   * principal, so daysToRecovery ignores any later top-up.
   */
  private async paymentFactsByDebt(
    principalById: Map<string, number>,
  ): Promise<Map<string, PaymentFacts>> {
    const facts = new Map<string, PaymentFacts>();
    const debtIds = [...principalById.keys()];
    if (debtIds.length === 0) return facts;

    const rows = await this.prisma.payment.findMany({
      where: { debtId: { in: debtIds } },
      select: { debtId: true, amount: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    for (const row of rows) {
      const current = facts.get(row.debtId) ?? { paidKobo: 0, settledAt: null };
      const paidKobo = current.paidKobo + row.amount;
      const principal = principalById.get(row.debtId) ?? 0;
      facts.set(row.debtId, {
        paidKobo,
        settledAt: current.settledAt ?? (paidKobo >= principal ? row.createdAt : null),
      });
    }
    return facts;
  }

  /** remindersSent = number of Reminder rows for the debt, in one grouped query. */
  private async reminderCountByDebt(debtIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (debtIds.length === 0) return counts;
    const grouped = await this.prisma.reminder.groupBy({
      by: ['debtId'],
      where: { debtId: { in: debtIds } },
      _count: { _all: true },
    });
    for (const g of grouped) counts.set(g.debtId, g._count._all);
    return counts;
  }

  private toDebtView(
    row: {
      id: string;
      amount: number;
      dueDate: Date | null;
      createdAt: Date;
      deleted: boolean;
      business: { businessName: string };
      customer: { name: string; phone: string };
    },
    facts: PaymentFacts,
    remindersSent: number,
    now: number,
  ): AdminDebtView {
    const remainingKobo = clampKobo(row.amount - facts.paidKobo);
    return {
      id: row.id,
      businessName: row.business.businessName,
      customerFirstName: firstName(row.customer.name),
      customerPhoneMasked: maskPhone(row.customer.phone),
      amountKobo: row.amount,
      remainingKobo,
      dueDate: row.dueDate ? row.dueDate.toISOString() : null,
      status: deriveAdminStatus(row.deleted, remainingKobo, facts.paidKobo, row.dueDate, now),
      remindersSent,
      daysToRecovery:
        remainingKobo <= 0 && facts.settledAt !== null
          ? this.daysBetween(row.createdAt, facts.settledAt)
          : null,
    };
  }

  /** Whole days between two instants, never negative (clock skew on back-dated rows). */
  private daysBetween(from: Date, to: Date): number {
    return Math.max(0, Math.round((to.getTime() - from.getTime()) / MS_PER_DAY));
  }

  /** [start, end) UTC bounds of the calendar month containing `now`. */
  private currentMonthRange(now: Date): { gte: Date; lt: Date } {
    return {
      gte: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      lt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
    };
  }
}

/**
 * Derive the admin status. Archived wins (the row is out of the ledger), then the
 * live severity order paid > overdue > partial, with the live outstanding/reminder/
 * scheduled severities collapsing to 'open'.
 */
function deriveAdminStatus(
  deleted: boolean,
  remainingKobo: number,
  paidKobo: number,
  dueDate: Date | null,
  now: number,
): AdminDebtStatus {
  if (deleted) return 'archived';
  if (remainingKobo <= 0) return 'paid';
  if (dueDate !== null && dueDate.getTime() < now) return 'overdue';
  if (paidKobo > 0) return 'partial';
  return 'open';
}

/** First whitespace-separated token of a customer name; '' stays ''. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

/** Mask every digit but the last 4, preserving length. Short/empty values mask fully. */
function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '*'.repeat(digits.length);
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}
