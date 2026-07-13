import { Injectable } from '@nestjs/common';
import { ReminderChannel } from '../shared';
import { PrismaService } from '../prisma/prisma.service';
import { PlanRequiredException } from '../common';
import { currentPeriodStart, isStalePeriod } from './period.util';
import { resolvePlanGrants, nextPlanId } from './plan-grants';

/** Raw SendAllowanceLedger row (one automated-send allowance ledger per business). */
interface SendAllowanceRow {
  businessId: string;
  remaining: number;
  monthlyGrant: number; // -1 = fair-use (unmetered)
  periodStart: Date;
}

/** Ledger state for GET /usage (periodStart serialized to ISO string). */
export interface SendAllowanceState {
  remaining: number;
  monthlyGrant: number;
  periodStart: string;
}

/** Channels that consume the automated-send allowance. call/manual/printable are free. */
const METERED_CHANNELS: ReadonlySet<ReminderChannel> = new Set<ReminderChannel>(['sms', 'whatsapp']);

/**
 * SendAllowanceService — the automated SMS/WhatsApp delivery allowance ledger
 * (conventions §Metering / §Reminder engine).
 *
 * The Reminders module injects this and calls `debitSend` when it dispatches an automated
 * send. Only `sms`/`whatsapp` are metered; `call`/`manual`/`printable` are recorded-only and
 * FREE (no debit). Exhaustion -> 403 PLAN_REQUIRED. Fair-use (-1) is unmetered, never blocks.
 * Billing message-bundle top-ups call `creditSend`. Grants refill lazily each monthly period.
 */
@Injectable()
export class SendAllowanceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Meter one automated send. Free channels (call/manual/printable) never touch the ledger.
   * Exhausted metered allowance -> 403 PLAN_REQUIRED. @returns the resulting remaining.
   */
  async debitSend(businessId: string, channel: ReminderChannel): Promise<number> {
    if (!METERED_CHANNELS.has(channel)) {
      // recorded-only + free: no debit
      return this.getRemaining(businessId);
    }

    const ledger = await this.ensure(businessId);
    if (ledger.monthlyGrant === -1) return ledger.remaining; // fair-use: unmetered, never blocks

    if (ledger.remaining <= 0) {
      const grants = await resolvePlanGrants(this.prisma, businessId);
      throw new PlanRequiredException(nextPlanId(grants.planId), 'Automated-send allowance exhausted');
    }

    const updated = await this.prisma.sendAllowanceLedger.update({
      where: { businessId },
      data: { remaining: { decrement: 1 } },
    });
    return updated.remaining;
  }

  /** Credit `amount` sends (e.g. a message bundle top-up). @returns the resulting remaining. */
  async creditSend(businessId: string, amount: number): Promise<number> {
    await this.ensure(businessId);
    const updated = await this.prisma.sendAllowanceLedger.update({
      where: { businessId },
      data: { remaining: { increment: amount } },
    });
    return updated.remaining;
  }

  /** Current remaining allowance (lazily initializes/refills the ledger). */
  async getRemaining(businessId: string): Promise<number> {
    const ledger = await this.ensure(businessId);
    return ledger.remaining;
  }

  /** Full ledger state for the GET /usage meter. */
  async getState(businessId: string): Promise<SendAllowanceState> {
    const ledger = await this.ensure(businessId);
    return {
      remaining: ledger.remaining,
      monthlyGrant: ledger.monthlyGrant,
      periodStart: ledger.periodStart.toISOString(),
    };
  }

  /**
   * Lazily create the ledger (grant from plan) if absent, or refill it to the plan's grant
   * when a new monthly period has begun. Idempotent within a period.
   */
  private async ensure(businessId: string): Promise<SendAllowanceRow> {
    const existing = (await this.prisma.sendAllowanceLedger.findUnique({
      where: { businessId },
    })) as SendAllowanceRow | null;
    const period = currentPeriodStart();

    if (!existing) {
      const grants = await resolvePlanGrants(this.prisma, businessId);
      const grant = grants.sendsPerMonth;
      return (await this.prisma.sendAllowanceLedger.create({
        data: { businessId, remaining: grant, monthlyGrant: grant, periodStart: period },
      })) as SendAllowanceRow;
    }

    if (isStalePeriod(existing.periodStart)) {
      const grants = await resolvePlanGrants(this.prisma, businessId);
      const grant = grants.sendsPerMonth;
      return (await this.prisma.sendAllowanceLedger.update({
        where: { businessId },
        data: { remaining: grant, monthlyGrant: grant, periodStart: period },
      })) as SendAllowanceRow;
    }

    return existing;
  }
}
