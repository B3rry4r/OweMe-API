import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlanRequiredException } from '../common';
import { currentPeriodStart, isStalePeriod } from './period.util';
import { resolvePlanGrants, nextPlanId } from './plan-grants';

/**
 * Weighted credit costs, on SUCCESS only (rev 2, FRONTEND-HANDOFF.md §4).
 * Manual deeplink sends and printable statements are unmetered (never debit).
 */
export const CREDIT_WEIGHTS = {
  reminderSend: 5, // one automated SMS/WhatsApp reminder
  voiceParse: 1, // one voice-to-debt parse
  insightOrRisk: 4, // one AI insight or customer-risk score
} as const;

/** Raw CreditLedger row (one shared AI-credit ledger per business). */
interface CreditLedgerRow {
  businessId: string;
  balance: number;
  monthlyGrant: number; // -1 = fair-use (unmetered)
  periodStart: Date;
}

/** Ledger state for GET /usage (periodStart serialized to ISO string). */
export interface CreditLedgerState {
  balance: number;
  monthlyGrant: number;
  periodStart: string;
}

/**
 * CreditLedgerService — the ONE shared AI-credits ledger (conventions §AI / §Metering).
 *
 * Downstream consumers (voice=1, insights=5, risk=5) inject this and call `debitCredits`
 * AFTER their operation succeeds (debit-on-success only). Billing bundle top-ups call
 * `creditCredits`. Weighted amounts are passed by the caller.
 *
 * Monthly grants refill lazily on read/debit at each new calendar-month period; the grant
 * comes from the business's plan. Fair-use (-1) is unmetered and NEVER blocks.
 */
@Injectable()
export class CreditLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Debit `weight` credits (called after a successful AI operation).
   * Fair-use plans are unmetered (no-op). Otherwise, insufficient balance -> 403 PLAN_REQUIRED.
   * @returns the resulting balance.
   */
  async debitCredits(businessId: string, weight: number, _reason?: string): Promise<number> {
    const ledger = await this.ensure(businessId);
    if (ledger.monthlyGrant === -1) return ledger.balance; // fair-use: unmetered, never blocks

    if (ledger.balance < weight) {
      const grants = await resolvePlanGrants(this.prisma, businessId);
      throw new PlanRequiredException(nextPlanId(grants.planId), 'Out of OweMe credits');
    }

    const updated = await this.prisma.creditLedger.update({
      where: { businessId },
      data: { balance: { decrement: weight } },
    });
    return updated.balance;
  }

  /** Credit `amount` credits (e.g. an AI-credit bundle top-up). @returns the resulting balance. */
  async creditCredits(businessId: string, amount: number, _source?: string): Promise<number> {
    await this.ensure(businessId);
    const updated = await this.prisma.creditLedger.update({
      where: { businessId },
      data: { balance: { increment: amount } },
    });
    return updated.balance;
  }

  /** Current credit balance (lazily initializes/refills the ledger). */
  async getBalance(businessId: string): Promise<number> {
    const ledger = await this.ensure(businessId);
    return ledger.balance;
  }

  /** Full ledger state for the GET /usage meter. */
  async getState(businessId: string): Promise<CreditLedgerState> {
    const ledger = await this.ensure(businessId);
    return {
      balance: ledger.balance,
      monthlyGrant: ledger.monthlyGrant,
      periodStart: ledger.periodStart.toISOString(),
    };
  }

  /**
   * Lazily create the ledger (grant from plan) if absent, or refill it to the plan's grant
   * when a new monthly period has begun. Idempotent within a period.
   */
  private async ensure(businessId: string): Promise<CreditLedgerRow> {
    const existing = (await this.prisma.creditLedger.findUnique({
      where: { businessId },
    })) as CreditLedgerRow | null;
    const period = currentPeriodStart();

    if (!existing) {
      const grants = await resolvePlanGrants(this.prisma, businessId);
      const grant = grants.creditsPerMonth;
      return (await this.prisma.creditLedger.create({
        data: { businessId, balance: grant, monthlyGrant: grant, periodStart: period },
      })) as CreditLedgerRow;
    }

    if (isStalePeriod(existing.periodStart)) {
      const grants = await resolvePlanGrants(this.prisma, businessId);
      const grant = grants.creditsPerMonth;
      // Top up to the plan's monthly grant, but never below the current balance:
      // purchased-bundle credits above the grant carry over (the trader paid for them).
      // Fair-use (-1) stays unmetered.
      const balance = grant < 0 ? grant : Math.max(existing.balance, grant);
      return (await this.prisma.creditLedger.update({
        where: { businessId },
        data: { balance, monthlyGrant: grant, periodStart: period },
      })) as CreditLedgerRow;
    }

    return existing;
  }
}
