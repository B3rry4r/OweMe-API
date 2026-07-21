import { Injectable } from '@nestjs/common';
import type { OtpRequestLog, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PAGINATION_DEFAULT_LIMIT } from '../../shared';
import {
  AdminOtpOutcome,
  AdminOtpRequestView,
  AdminOtpSeriesView,
  AdminOtpStatsView,
  AdminRevocationView,
  AdminSessionSecurityView,
  AdminTestNumberView,
  Paged,
} from './admin-auth-monitor.views';
import {
  OTP_SERIES_DEFAULT_DAYS,
  OtpRequestsQueryDto,
  OtpSeriesQueryDto,
  SessionsQueryDto,
} from './dto/admin-auth-monitor.dto';

/**
 * Auth-monitor reads (registry AdminAuthMonitorView). READ-ONLY over the protected
 * auth surface: otp_request_log rows are written exclusively by the auth.service
 * instrumentation, OtpCode/RefreshToken/Business/Staff are read and never written.
 * Every reader is empty-safe: with zero rows the panels return honest zeros, empty
 * arrays and nulls rather than erroring, which is the state until instrumentation lands.
 */

/** Outcomes that mean "a code left the building" (a request that was not throttled away). */
const OTP_REQUEST_OUTCOMES: AdminOtpOutcome[] = ['requested', 'delivered-unknown'];

/**
 * Outcomes carrying a RESOLVED provider delivery receipt. Empty today: BulkSMSNigeria
 * reports nothing back, so every dispatch stays 'delivered-unknown' and
 * deliverySuccessPct is served as null (honest-display ruling) rather than a fake 100%.
 */
const OTP_DELIVERY_RESOLVED_OUTCOMES: AdminOtpOutcome[] = [];

/** Delivery receipts that count as a success once the provider starts reporting. */
const OTP_DELIVERY_SUCCESS_OUTCOMES: AdminOtpOutcome[] = [];

const SESSION_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Safety stop when walking a rotatedFrom chain (a cycle can never be produced, but bound it anyway). */
const MAX_CHAIN_WALK = 50;

@Injectable()
export class AdminAuthMonitorService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /admin/auth-monitor/stats - today's OTP health, zeros/null on the empty table. */
  async stats(): Promise<AdminOtpStatsView> {
    const today = { gte: this.startOfUtcDay(new Date()) };

    const [otpRequestsToday, failedVerificationsToday, rateLimitBlocksToday, resolved, delivered] =
      await this.prisma.$transaction([
        this.prisma.otpRequestLog.count({
          where: { createdAt: today, outcome: { in: OTP_REQUEST_OUTCOMES } },
        }),
        this.prisma.otpRequestLog.count({ where: { createdAt: today, outcome: 'failed' } }),
        this.prisma.otpRequestLog.count({ where: { createdAt: today, outcome: 'rate-limited' } }),
        this.prisma.otpRequestLog.count({
          where: { createdAt: today, outcome: { in: OTP_DELIVERY_RESOLVED_OUTCOMES } },
        }),
        this.prisma.otpRequestLog.count({
          where: { createdAt: today, outcome: { in: OTP_DELIVERY_SUCCESS_OUTCOMES } },
        }),
      ]);

    return {
      otpRequestsToday,
      // No resolved receipts -> null, never a manufactured percentage.
      deliverySuccessPct: resolved === 0 ? null : Math.round((delivered / resolved) * 100),
      failedVerificationsToday,
      rateLimitBlocksToday,
    };
  }

  /**
   * GET /admin/auth-monitor/series - daily request counts, oldest first, one entry per
   * day in the window including days with no rows (zero-filled, never a short array).
   */
  async series(query: OtpSeriesQueryDto): Promise<AdminOtpSeriesView> {
    const days = query.days ?? OTP_SERIES_DEFAULT_DAYS;
    const endDay = this.startOfUtcDay(new Date());
    const startDay = new Date(endDay.getTime() - (days - 1) * DAY_MS);

    const rows = await this.prisma.otpRequestLog.findMany({
      where: { createdAt: { gte: startDay }, outcome: { in: OTP_REQUEST_OUTCOMES } },
      select: { createdAt: true },
    });

    const counts = new Array<number>(days).fill(0);
    for (const row of rows) {
      const index = Math.floor(
        (this.startOfUtcDay(row.createdAt).getTime() - startDay.getTime()) / DAY_MS,
      );
      if (index >= 0 && index < days) counts[index] += 1;
    }

    return {
      startDate: this.isoDate(startDay),
      endDate: this.isoDate(endDay),
      counts,
    };
  }

  /** GET /admin/auth-monitor/requests - offset-paged log feed, newest first. */
  async requests(query: OtpRequestsQueryDto): Promise<Paged<AdminOtpRequestView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;

    const where: Prisma.OtpRequestLogWhereInput = {
      ...(query.outcome ? { outcome: query.outcome } : {}),
      // Search runs against the MASKED digits: the full number was never stored.
      ...(query.phoneDigits ? { phoneMasked: { contains: query.phoneDigits } } : {}),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.otpRequestLog.count({ where }),
      this.prisma.otpRequestLog.findMany({
        where,
        // uuidv7 id desc tiebreaks same-millisecond rows in creation order.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return { data: rows.map((row) => this.toRequestView(row)), page, total };
  }

  /**
   * GET /admin/auth-monitor/test-numbers - superadmin only. The isTest = true filter is
   * SERVER-SIDE and structural, so a real user's phone can never appear here. Codes are
   * never bulk-shipped with the list: only the live-code expiry state is exposed, and the
   * reveal itself is the separate audited action.
   */
  async testNumbers(): Promise<AdminTestNumberView[]> {
    const businesses = await this.prisma.business.findMany({
      where: { isTest: true },
      select: { id: true, businessName: true, phone: true },
      orderBy: [{ businessName: 'asc' }, { id: 'asc' }],
    });
    if (businesses.length === 0) return [];

    const now = new Date();
    const live = await this.prisma.otpCode.findMany({
      where: { phone: { in: businesses.map((b) => b.phone) }, expiresAt: { gt: now } },
      select: { phone: true, expiresAt: true },
    });
    // Latest expiry wins when a phone has several outstanding codes.
    const expiryByPhone = new Map<string, Date>();
    for (const code of live) {
      const current = expiryByPhone.get(code.phone);
      if (!current || code.expiresAt > current) expiryByPhone.set(code.phone, code.expiresAt);
    }

    return businesses.map((business) => {
      const expiresAt = expiryByPhone.get(business.phone) ?? null;
      return {
        businessId: business.id,
        businessName: business.businessName,
        phone: business.phone,
        hasActiveCode: expiresAt !== null,
        expiresAt: expiresAt === null ? null : expiresAt.toISOString(),
      };
    });
  }

  /**
   * GET /admin/auth-monitor/sessions - read-only aggregation over RefreshToken (gap-1).
   * Raw counts and the revocation feed work day one; the reuse-vs-logout split stays null
   * until the optional RefreshToken.revokedReason instrumentation starts writing reasons.
   */
  async sessions(query: SessionsQueryDto): Promise<AdminSessionSecurityView> {
    const page = query.page ?? 1;
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;
    const now = new Date();
    const since = new Date(now.getTime() - SESSION_WINDOW_DAYS * DAY_MS);
    const revokedWindow: Prisma.RefreshTokenWhereInput = { revokedAt: { gte: since } };

    const [activeSessionCount, revokedLast7d, reasoned, reuse, logout, total] =
      await this.prisma.$transaction([
        this.prisma.refreshToken.count({ where: { revokedAt: null, expiresAt: { gt: now } } }),
        this.prisma.refreshToken.count({ where: revokedWindow }),
        this.prisma.refreshToken.count({
          where: { ...revokedWindow, revokedReason: { not: null } },
        }),
        this.prisma.refreshToken.count({ where: { ...revokedWindow, revokedReason: 'reuse' } }),
        this.prisma.refreshToken.count({ where: { ...revokedWindow, revokedReason: 'logout' } }),
        this.prisma.refreshToken.count({ where: { revokedAt: { not: null } } }),
      ]);

    const rows = await this.prisma.refreshToken.findMany({
      where: { revokedAt: { not: null } },
      orderBy: [{ revokedAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        userId: true,
        rotatedFrom: true,
        revokedAt: true,
        revokedReason: true,
        expiresAt: true,
        user: { select: { business: { select: { businessName: true } } } },
      },
    });

    const chainDepths = await this.chainDepths(rows.map((row) => row.rotatedFrom));
    const data: AdminRevocationView[] = rows.map((row, index) => ({
      staffId: row.userId,
      businessName: row.user?.business?.businessName ?? null,
      // revokedAt is non-null by the where clause; the guard keeps the type honest.
      revokedAt: (row.revokedAt ?? now).toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      chainDepth: chainDepths[index],
      reason: row.revokedReason,
    }));

    // Uninstrumented window -> null rather than a misleading zero.
    const instrumented = reasoned > 0;
    return {
      activeSessionCount,
      revokedLast7d,
      reuseIncidentsLast7d: instrumented ? reuse : null,
      logoutRevocationsLast7d: instrumented ? logout : null,
      recentRevocations: { data, page, total },
    };
  }

  // --- internals -----------------------------------------------------------

  /**
   * Walk every row's rotatedFrom chain one LEVEL at a time (one query per level for the
   * whole page, not one per row) and return the depth per input position.
   */
  private async chainDepths(rotatedFrom: (string | null)[]): Promise<number[]> {
    const depths = new Array<number>(rotatedFrom.length).fill(0);
    let cursors = [...rotatedFrom];

    for (let level = 0; level < MAX_CHAIN_WALK; level += 1) {
      const ids = [...new Set(cursors.filter((id): id is string => id !== null))];
      if (ids.length === 0) break;

      const parents = await this.prisma.refreshToken.findMany({
        where: { id: { in: ids } },
        select: { id: true, rotatedFrom: true },
      });
      const parentById = new Map(parents.map((p) => [p.id, p.rotatedFrom]));

      cursors = cursors.map((cursor, index) => {
        if (cursor === null) return null;
        // A missing parent row still counts as one rotation, then the chain stops.
        depths[index] += 1;
        return parentById.get(cursor) ?? null;
      });
    }

    return depths;
  }

  private toRequestView(row: OtpRequestLog): AdminOtpRequestView {
    const outcome = row.outcome as AdminOtpOutcome;
    return {
      id: row.id,
      requestedAt: row.createdAt.toISOString(),
      phoneMasked: row.phoneMasked,
      outcome,
      attempts: row.attempts,
      rateLimited: outcome === 'rate-limited',
    };
  }

  private startOfUtcDay(at: Date): Date {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  }

  private isoDate(day: Date): string {
    return day.toISOString().slice(0, 10);
  }
}
