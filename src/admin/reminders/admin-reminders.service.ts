import { Injectable } from '@nestjs/common';
import type { Prisma, Reminder } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PAGINATION_DEFAULT_LIMIT, ReminderChannel, ReminderStatus } from '../../shared';
import { CREDIT_WEIGHTS } from '../../usage/credit-ledger.service';
import { AdminRemindersQueryDto, AdminSmsCostSeriesQueryDto } from './dto/admin-reminders.dto';
import {
  AdminReminderStatsView,
  AdminReminderView,
  AdminSmsCostPointView,
  Paged,
} from './admin-reminders.views';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Read-only reminder monitor for the admin surface (registry AdminRemindersView).
 * Every number comes from live Reminder rows and usage_events; nothing this
 * service cannot evidence is invented - delivery counts stay null because no
 * delivery receipts exist, and per-reminder cost stays null until usage_events
 * carry meta.reminderId. Both usage_events readers are empty-safe: a table with
 * zero rows yields honest nulls, never an error.
 */
@Injectable()
export class AdminRemindersService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /admin/reminders/stats - current calendar month, resolved server-side. */
  async stats(now: Date = new Date()): Promise<AdminReminderStatsView> {
    const { gte, lt } = this.monthRange(now);
    const sentThisMonth: Prisma.ReminderWhereInput = {
      status: 'sent',
      sentAt: { gte, lt },
    };

    const [sendsThisMonth, smsSendsThisMonth, cost] = await this.prisma.$transaction([
      this.prisma.reminder.count({ where: sentThisMonth }),
      this.prisma.reminder.count({ where: { ...sentThisMonth, channel: 'sms' } }),
      this.prisma.usageEvent.aggregate({
        _sum: { costKoboEstimate: true },
        where: { type: 'send', createdAt: { gte, lt } },
      }),
    ]);

    return {
      sendsThisMonth,
      // No delivery receipts exist anywhere in the stack: honest-empty by ruling.
      deliveredThisMonth: null,
      smsSendsThisMonth,
      // Prisma returns null when no row carries a cost, which is exactly the contract.
      smsCostThisMonthKobo: cost._sum.costKoboEstimate ?? null,
      creditsPerSend: CREDIT_WEIGHTS.reminderSend,
      month: this.monthKey(now),
    };
  }

  /** GET /admin/reminders - offset-paged, newest first, cross-tenant read. */
  async list(query: AdminRemindersQueryDto): Promise<Paged<AdminReminderView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;

    const where: Prisma.ReminderWhereInput = {
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.reminder.count({ where }),
      this.prisma.reminder.findMany({
        where,
        // uuidv7 id desc tiebreaks same-millisecond rows in creation order.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const nameById = await this.businessNames(rows);
    return { data: rows.map((row) => this.toView(row, nameById)), page, total };
  }

  /**
   * GET /admin/reminders/sms-cost-series - weekly average of the cost estimate
   * carried by 'send' usage events. Buckets are Monday-aligned UTC and always
   * returned in full: a week with no priced rows (or an entirely empty table)
   * yields costPerSmsAvgKobo null, which the sparkline renders as its empty state.
   */
  async smsCostSeries(
    query: AdminSmsCostSeriesQueryDto,
    now: Date = new Date(),
  ): Promise<AdminSmsCostPointView[]> {
    const weeks = query.weeks ?? 12;
    const currentWeekStart = this.weekStart(now);
    const firstWeekStart = new Date(currentWeekStart.getTime() - (weeks - 1) * WEEK_MS);

    const rows = await this.prisma.usageEvent.findMany({
      where: {
        type: 'send',
        costKoboEstimate: { not: null },
        createdAt: { gte: firstWeekStart },
      },
      select: { costKoboEstimate: true, createdAt: true },
    });

    const totals = new Map<number, { sum: number; count: number }>();
    for (const row of rows) {
      const bucket = Math.floor(
        (this.weekStart(row.createdAt).getTime() - firstWeekStart.getTime()) / WEEK_MS,
      );
      if (bucket < 0 || bucket >= weeks) continue;
      const acc = totals.get(bucket) ?? { sum: 0, count: 0 };
      acc.sum += row.costKoboEstimate ?? 0;
      acc.count += 1;
      totals.set(bucket, acc);
    }

    return Array.from({ length: weeks }, (_unused, bucket) => {
      const acc = totals.get(bucket);
      return {
        weekStart: new Date(firstWeekStart.getTime() + bucket * WEEK_MS)
          .toISOString()
          .slice(0, 10),
        costPerSmsAvgKobo: acc ? Math.round(acc.sum / acc.count) : null,
      };
    });
  }

  // --- internals -----------------------------------------------------------

  /** Resolve businessName for the page's rows in one query. */
  private async businessNames(rows: Reminder[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((row) => row.businessId))];
    if (ids.length === 0) return new Map();
    const businesses = await this.prisma.business.findMany({
      where: { id: { in: ids } },
      select: { id: true, businessName: true },
    });
    return new Map(businesses.map((b) => [b.id, b.businessName]));
  }

  /** [start, end) UTC bounds for the calendar month containing `now`. */
  private monthRange(now: Date): { gte: Date; lt: Date } {
    return {
      gte: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      lt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
    };
  }

  private monthKey(now: Date): string {
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  /** Monday 00:00:00 UTC of the week containing `at`. */
  private weekStart(at: Date): Date {
    const day = at.getUTCDay(); // 0 = Sunday
    const backToMonday = (day + 6) % 7;
    return new Date(
      Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - backToMonday),
    );
  }

  private toView(row: Reminder, businessNameById: Map<string, string>): AdminReminderView {
    return {
      id: row.id,
      businessName: businessNameById.get(row.businessId) ?? '',
      channel: row.channel as ReminderChannel,
      // Schedule steps are derived on the fly by the app, never stored.
      step: null,
      scheduledFor: row.scheduledFor?.toISOString() ?? null,
      sentAt: row.sentAt?.toISOString() ?? null,
      status: row.status as ReminderStatus,
      // usage_events carry no meta.reminderId yet; null until that instrumentation lands.
      costKoboEstimate: null,
    };
  }
}
