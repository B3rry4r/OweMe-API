import { Module } from '@nestjs/common';
import { UsageController } from './usage.controller';
import { UsageService } from './usage.service';
import { CreditLedgerService } from './credit-ledger.service';
import { UsageEventRecorder } from './usage-event.recorder';

/**
 * Usage / ledger module — owns the ONE unified OweMe-credits ledger (model rev 2).
 *
 * Exports CreditLedgerService so downstream modules inject it:
 *   - Reminders (automated send = 5) / Voice (parse = 1) / Insights|Risk (= 4)
 *     -> CreditLedgerService.debitCredits (weighted, debit-on-success)
 *   - Billing -> creditCredits (unified credit-bundle top-ups)
 *
 * PrismaService is provided by the global PrismaModule.
 */
@Module({
  controllers: [UsageController],
  providers: [UsageService, CreditLedgerService, UsageEventRecorder],
  exports: [CreditLedgerService, UsageEventRecorder],
})
export class UsageModule {}
