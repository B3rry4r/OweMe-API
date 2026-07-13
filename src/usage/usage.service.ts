import { Injectable } from '@nestjs/common';
import { UsageResponse } from '../shared';
import { CreditLedgerService } from './credit-ledger.service';
import { SendAllowanceService } from './send-allowance.service';
import { usedFrom } from './period.util';

/**
 * UsageService — composes the GET /usage view from both ledgers. Reading lazily initializes
 * (and refills, on a new period) each ledger from the business's plan. Caps come from Plan limits.
 */
@Injectable()
export class UsageService {
  constructor(
    private readonly credits: CreditLedgerService,
    private readonly sends: SendAllowanceService,
  ) {}

  async getUsage(businessId: string): Promise<UsageResponse> {
    const [send, credit] = await Promise.all([
      this.sends.getState(businessId),
      this.credits.getState(businessId),
    ]);

    return {
      sendAllowance: {
        used: usedFrom(send.monthlyGrant, send.remaining),
        remaining: send.remaining,
        monthlyGrant: send.monthlyGrant,
        periodStart: send.periodStart,
      },
      aiCredits: {
        used: usedFrom(credit.monthlyGrant, credit.balance),
        balance: credit.balance,
        monthlyGrant: credit.monthlyGrant,
        periodStart: credit.periodStart,
      },
    };
  }
}
