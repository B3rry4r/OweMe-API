import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { UsageModule } from '../usage/usage.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

/**
 * BillingModule — Subscription/IAP surface (wave 3).
 *
 * Imports UsageModule solely for its EXPORTED ledger services (CreditLedgerService,
 * SendAllowanceService) which billing injects for bundle top-ups. RECEIPT_VERIFIER +
 * guards come from the global CommonModule; PrismaService from the global PrismaModule.
 */
@Module({
  imports: [PrismaModule, UsageModule],
  controllers: [BillingController],
  providers: [BillingService],
})
export class BillingModule {}
