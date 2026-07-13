import { Injectable } from '@nestjs/common';
import { UsageResponse } from '../shared';
import { CreditLedgerService } from './credit-ledger.service';
import { usedFrom } from './period.util';

/**
 * UsageService — composes the GET /usage view from the ONE unified OweMe-credits ledger
 * (model rev 2). Reading lazily initializes/refills the ledger from the business's plan
 * grant. `limit` is the monthly grant (-1 = fair-use, unmetered).
 */
@Injectable()
export class UsageService {
  constructor(private readonly credits: CreditLedgerService) {}

  async getUsage(businessId: string): Promise<UsageResponse> {
    const credit = await this.credits.getState(businessId);
    return {
      credits: {
        used: usedFrom(credit.monthlyGrant, credit.balance),
        limit: credit.monthlyGrant,
        balance: credit.balance,
        monthlyGrant: credit.monthlyGrant,
        periodStart: credit.periodStart,
      },
    };
  }
}
