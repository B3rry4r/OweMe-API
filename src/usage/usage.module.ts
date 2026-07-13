import { Module } from '@nestjs/common';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';
import { CreditLedgerService } from './credit-ledger.service';
import { SendAllowanceService } from './send-allowance.service';

/**
 * Usage / ledgers module — owns both metering ledgers (CreditLedger + SendAllowanceLedger).
 *
 * Exports CreditLedgerService + SendAllowanceService so downstream modules inject them:
 *   - Reminders    -> SendAllowanceService.debitSend
 *   - Voice/Insights/Risk -> CreditLedgerService.debitCredits (weighted, debit-on-success)
 *   - Billing      -> creditCredits / creditSend (bundle top-ups)
 *
 * PrismaService is provided by the global PrismaModule.
 */
@Module({
  controllers: [UsageController],
  providers: [UsageService, CreditLedgerService, SendAllowanceService],
  exports: [CreditLedgerService, SendAllowanceService],
})
export class UsageModule {}
