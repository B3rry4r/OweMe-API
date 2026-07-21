import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { uuidv7 } from '../common';

/**
 * Cost of ONE outbound SMS page on the current provider route (BulkSMSNigeria), in kobo.
 * Sourced from env so a route/price change is an ops action, not a code change; the default
 * is the ₦3.50/page list price of the route the MESSAGE_SENDER provider is pointed at today.
 * Used ONLY as the `costKoboEstimate` on usage_events rows (reporting), never in a money path.
 */
export const SMS_ROUTE_COST_KOBO_DEFAULT = 350; // ₦3.50 per SMS page on the current route
export const SMS_ROUTE_COST_KOBO = Number.isFinite(Number(process.env.SMS_ROUTE_COST_KOBO))
  ? Number(process.env.SMS_ROUTE_COST_KOBO)
  : SMS_ROUTE_COST_KOBO_DEFAULT;

export type UsageEventType = 'send' | 'voiceParse' | 'insight';

/**
 * UsageEventRecorder — best-effort append-only instrumentation of credit-debiting events
 * into usage_events (the admin credits / AI-usage panels read it).
 *
 * Contract: writing an event MUST NEVER fail, slow or alter a user-facing request. Every
 * write is try/catch'd and a failure is logged and swallowed. Nothing here is authoritative:
 * the CreditLedger remains the source of truth for balances.
 */
@Injectable()
export class UsageEventRecorder {
  private readonly logger = new Logger(UsageEventRecorder.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Append one usage event. Never throws. `meta` is metadata ONLY (never transcripts). */
  async record(event: {
    businessId: string;
    type: UsageEventType;
    credits: number;
    costKoboEstimate?: number | null;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.prisma.usageEvent.create({
        data: {
          id: uuidv7(),
          businessId: event.businessId,
          type: event.type,
          credits: event.credits,
          costKoboEstimate: event.costKoboEstimate ?? null,
          meta: (event.meta ?? undefined) as never,
        },
      });
    } catch (err) {
      this.logger.warn(`usage_events write failed (${event.type}): ${String(err)}`);
    }
  }
}
