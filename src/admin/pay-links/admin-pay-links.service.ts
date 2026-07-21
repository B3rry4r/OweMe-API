import { Injectable } from '@nestjs/common';
import type { Prisma, WebhookEventLog } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PAGINATION_DEFAULT_LIMIT } from '../../shared';
import { combinedPayLinkFeeKobo, owemeCommissionKobo } from '../../debts/pay-link-fees';
import {
  PayLinkPaymentsQueryDto,
  PayLinkStatsQueryDto,
  WebhookEventsQueryDto,
} from './dto/admin-pay-links.dto';
import {
  AdminPayLinkPaymentView,
  AdminPayLinkStatsView,
  AdminWebhookEventView,
  AdminWebhookEventsView,
  AdminWebhookOutcome,
  AdminWebhookSource,
  Paged,
} from './admin-pay-links.views';

/**
 * Pay-link money reads for the admin surface (registry AdminPayLinksView). Read-only:
 * every figure is either a live Payment column or DERIVED at read time from the one
 * authoritative fee module (src/debts/pay-link-fees.ts), so the dashboard can never
 * drift from what the gateway actually split. Fee breakdowns are never persisted and
 * never computed client-side.
 */

/** The verbatim Payment.method the Paystack webhook records (src/webhooks/webhooks.service.ts:140). */
const PAY_LINK_METHOD = 'Paystack link';

@Injectable()
export class AdminPayLinksService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /admin/pay-links/payments - offset-paged pay-link settlements for one month. */
  async payments(query: PayLinkPaymentsQueryDto): Promise<Paged<AdminPayLinkPaymentView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;
    const month = query.month ?? this.currentMonth();

    const where: Prisma.PaymentWhereInput = {
      method: PAY_LINK_METHOD,
      createdAt: this.monthRange(month),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({
        where,
        // uuidv7 id desc tiebreaks same-millisecond rows in creation order.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          business: { select: { businessName: true } },
          debt: { select: { customer: { select: { name: true } } } },
        },
      }),
    ]);

    const data = rows.map((row) => {
      const combinedFeeKobo = combinedPayLinkFeeKobo(row.amount);
      const commissionKobo = owemeCommissionKobo(row.amount);
      return {
        id: row.id,
        at: row.createdAt.toISOString(),
        businessName: row.business.businessName,
        debtorFirstName: this.firstName(row.debt.customer.name),
        amountKobo: row.amount,
        combinedFeeKobo,
        commissionKobo,
        processorShareKobo: combinedFeeKobo - commissionKobo,
        status: 'success' as const,
      };
    });

    return { data, page, total };
  }

  /**
   * GET /admin/pay-links/stats - month aggregates. The fee columns are summed
   * per row through the fee formulas (they are per-payment capped, so a cap
   * applied to the month total would be wrong).
   */
  async stats(query: PayLinkStatsQueryDto): Promise<AdminPayLinkStatsView> {
    const month = query.month ?? this.currentMonth();
    const rows = await this.prisma.payment.findMany({
      where: { method: PAY_LINK_METHOD, createdAt: this.monthRange(month) },
      select: { amount: true },
    });

    let volumeKobo = 0;
    let feesChargedKobo = 0;
    let commissionKeptKobo = 0;
    for (const row of rows) {
      volumeKobo += row.amount;
      feesChargedKobo += combinedPayLinkFeeKobo(row.amount);
      commissionKeptKobo += owemeCommissionKobo(row.amount);
    }

    return {
      settledCount: rows.length,
      volumeKobo,
      feesChargedKobo,
      commissionKeptKobo,
      month,
    };
  }

  /**
   * GET /admin/webhooks/events - offset-paged webhook_event_log reads. The table is
   * empty until the webhook instrumentation writes to it; that reads as honest zeros
   * ({ data: [], total: 0, errorCount: 0 }), never an error.
   */
  async webhookEvents(query: WebhookEventsQueryDto): Promise<AdminWebhookEventsView> {
    const page = query.page ?? 1;
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;

    const where: Prisma.WebhookEventLogWhereInput = {
      ...(query.source ? { source: query.source } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
    };

    const [total, rows, errorCount] = await this.prisma.$transaction([
      this.prisma.webhookEventLog.count({ where }),
      this.prisma.webhookEventLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      // Deliberately UNFILTERED: the section subtitle counts every error row, not
      // the errors inside the current filter.
      this.prisma.webhookEventLog.count({ where: { outcome: 'error' } }),
    ]);

    return { data: rows.map((row) => this.toEventView(row)), page, total, errorCount };
  }

  // --- internals -----------------------------------------------------------

  private toEventView(row: WebhookEventLog): AdminWebhookEventView {
    return {
      id: row.id,
      at: row.createdAt.toISOString(),
      source: row.source as AdminWebhookSource,
      eventType: row.eventType,
      reference: row.reference,
      outcome: row.outcome as AdminWebhookOutcome,
      detail: row.detail === null ? null : (row.detail as object),
    };
  }

  /** Leading token of the stored customer name; the whole name when it is one word. */
  private firstName(name: string): string {
    return name.trim().split(/\s+/)[0] ?? '';
  }

  /** Current UTC month as YYYY-MM. */
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
