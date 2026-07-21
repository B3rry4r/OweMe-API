import { Injectable } from '@nestjs/common';
import type { Prisma, UsageEvent } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { currentPeriodStart } from '../../usage/period.util';
import {
  AI_USAGE_DEFAULT_LIMIT,
  AiByBusinessQueryDto,
  AiRecentParsesQueryDto,
  AiSeriesQueryDto,
} from './dto/admin-ai-usage.dto';
import {
  AdminAiBusinessView,
  AdminAiParseEventView,
  AdminAiStatsView,
  AdminAiWeekPointView,
  Paged,
} from './admin-ai-usage.views';

const DEFAULT_WEEKS = 12;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Fallback outcome label when the instrumentation wrote no meta.outcome. */
const UNKNOWN_OUTCOME = 'unknown';
/** Shown when the usage_events row outlives its Business row. */
const UNKNOWN_BUSINESS = 'Unknown business';

/**
 * AI-usage reads over the NEW append-only usage_events table (registry AdminAiUsageView).
 * Read-only: nothing here writes, so no audit rows are recorded.
 *
 * Two honesty rules run through every method. First, the backend only ever sees FALLBACK
 * parses - on-device parses are decided by a client heuristic and never reach the server -
 * so onDeviceParses/onDeviceSharePct/onDevicePct are null, never a fabricated zero or
 * share. Second, the table starts empty (instrumentation lands in a later fenced task), so
 * every reader returns honest zeros/empty arrays rather than erroring.
 */
@Injectable()
export class AdminAiUsageService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /admin/ai-usage/stats - current UTC calendar month, matching the credit period. */
  async stats(now: Date = new Date()): Promise<AdminAiStatsView> {
    const periodStart = currentPeriodStart(now);
    const where: Prisma.UsageEventWhereInput = {
      type: 'voiceParse',
      createdAt: { gte: periodStart },
    };

    const [parses, cost] = await this.prisma.$transaction([
      this.prisma.usageEvent.count({ where }),
      this.prisma.usageEvent.aggregate({
        where,
        _sum: { costKoboEstimate: true },
        _count: { costKoboEstimate: true },
      }),
    ]);

    return {
      parsesTotal: parses,
      fallbackParses: parses,
      onDeviceParses: null,
      onDeviceSharePct: null,
      // Null (not 0) while no row carries an estimate: an unrecorded cost is unknown, not free.
      modelSpendEstimateKobo:
        cost._count.costKoboEstimate > 0 ? cost._sum.costKoboEstimate ?? 0 : null,
      periodMonth: this.monthKey(periodStart),
    };
  }

  /**
   * GET /admin/ai-usage/series - weekly parse counts, oldest first, ending with the
   * in-progress week. Weeks start Monday 00:00 UTC. Empty weeks are emitted as 0 so the
   * chart always gets `weeks` points (all-zero from the empty table).
   */
  async series(query: AiSeriesQueryDto, now: Date = new Date()): Promise<AdminAiWeekPointView[]> {
    const weeks = query.weeks ?? DEFAULT_WEEKS;
    const currentWeekStart = this.weekStart(now);
    const firstWeekStart = new Date(currentWeekStart.getTime() - (weeks - 1) * WEEK_MS);

    const rows = await this.prisma.usageEvent.findMany({
      where: { type: 'voiceParse', createdAt: { gte: firstWeekStart } },
      select: { createdAt: true },
    });

    const counts = new Array<number>(weeks).fill(0);
    for (const row of rows) {
      const index = Math.floor((row.createdAt.getTime() - firstWeekStart.getTime()) / WEEK_MS);
      if (index >= 0 && index < weeks) counts[index] += 1;
    }

    return counts.map((parses, index) => ({
      weekStart: this.isoDate(new Date(firstWeekStart.getTime() + index * WEEK_MS)),
      parses,
    }));
  }

  /**
   * GET /admin/ai-usage/by-business - current-month rollup grouped by businessId over the
   * voiceParse + insight event types, sorted by parses desc. insight counts stay 0 while the
   * insights endpoints are 501 scaffolds. Groups whose Business row no longer exists are
   * dropped: their name and plan are unresolvable, and inventing a plan would corrupt the
   * plan filter.
   */
  async byBusiness(
    query: AiByBusinessQueryDto,
    now: Date = new Date(),
  ): Promise<Paged<AdminAiBusinessView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? AI_USAGE_DEFAULT_LIMIT;
    const periodStart = currentPeriodStart(now);

    const grouped = await this.prisma.usageEvent.groupBy({
      by: ['businessId', 'type'],
      where: { type: { in: ['voiceParse', 'insight'] }, createdAt: { gte: periodStart } },
      _count: { _all: true },
      _sum: { credits: true },
    });
    if (grouped.length === 0) return { data: [], page, total: 0 };

    const businesses = await this.prisma.business.findMany({
      where: { id: { in: [...new Set(grouped.map((g) => g.businessId))] } },
      select: { id: true, businessName: true, plan: true },
    });
    const byId = new Map(businesses.map((b) => [b.id, b]));

    const rollup = new Map<string, AdminAiBusinessView>();
    for (const group of grouped) {
      const business = byId.get(group.businessId);
      if (!business) continue;
      if (query.plan && business.plan !== query.plan) continue;

      const row =
        rollup.get(group.businessId) ??
        ({
          businessId: business.id,
          businessName: business.businessName,
          plan: business.plan,
          parses: 0,
          onDevicePct: null,
          insights: 0,
          creditsDebited: 0,
        } satisfies AdminAiBusinessView);
      if (group.type === 'voiceParse') row.parses += group._count._all;
      if (group.type === 'insight') row.insights += group._count._all;
      row.creditsDebited += group._sum.credits ?? 0;
      rollup.set(group.businessId, row);
    }

    // Name is the stable tiebreak so paging over equal parse counts never repeats a row.
    const data = [...rollup.values()].sort(
      (a, b) => b.parses - a.parses || a.businessName.localeCompare(b.businessName),
    );
    const skip = (page - 1) * limit;
    return { data: data.slice(skip, skip + limit), page, total: data.length };
  }

  /**
   * GET /admin/ai-usage/recent-parses - METADATA ONLY per the final ruling: time, business,
   * outcome, credits. Transcripts are never stored in usage_events.meta and therefore can
   * never surface here.
   */
  async recentParses(query: AiRecentParsesQueryDto): Promise<Paged<AdminAiParseEventView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? AI_USAGE_DEFAULT_LIMIT;
    const where: Prisma.UsageEventWhereInput = { type: 'voiceParse' };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.usageEvent.count({ where }),
      this.prisma.usageEvent.findMany({
        where,
        // uuidv7 id desc tiebreaks same-millisecond rows in creation order.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const nameById = await this.businessNames(rows);
    return {
      data: rows.map((row) => ({
        id: row.id,
        at: row.createdAt.toISOString(),
        businessId: row.businessId,
        businessName: nameById.get(row.businessId) ?? UNKNOWN_BUSINESS,
        outcome: this.outcomeOf(row.meta),
        creditsCharged: row.credits,
      })),
      page,
      total,
    };
  }

  // --- internals -------------------------------------------------------------

  private async businessNames(rows: UsageEvent[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((r) => r.businessId))];
    if (ids.length === 0) return new Map();
    const businesses = await this.prisma.business.findMany({
      where: { id: { in: ids } },
      select: { id: true, businessName: true },
    });
    return new Map(businesses.map((b) => [b.id, b.businessName]));
  }

  /** meta.outcome when the instrumentation recorded one; honest 'unknown' otherwise. */
  private outcomeOf(meta: Prisma.JsonValue | null): string {
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return UNKNOWN_OUTCOME;
    const outcome = (meta as Prisma.JsonObject)['outcome'];
    return typeof outcome === 'string' && outcome.length > 0 ? outcome : UNKNOWN_OUTCOME;
  }

  /** Monday 00:00 UTC of the week containing `at`. */
  private weekStart(at: Date): Date {
    const midnight = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    // getUTCDay(): 0 = Sunday, so Sunday sits at the END of its Monday-started week.
    const offset = (midnight.getUTCDay() + 6) % 7;
    return new Date(midnight.getTime() - offset * 24 * 60 * 60 * 1000);
  }

  private isoDate(at: Date): string {
    return at.toISOString().slice(0, 10);
  }

  private monthKey(at: Date): string {
    return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
  }
}
