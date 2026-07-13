import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CommonModule } from '../common/common.module';
import { BvumModule } from '../bvum/bvum.module';
import { DebtsController } from './debts.controller';
import { DebtsService } from './debts.service';

/**
 * Debts (receivables ledger) feature module. Register in app.module: `DebtsModule`.
 * Imports CommonModule for the PAYSTACK_GATEWAY provider (pay-link) and BvumModule for
 * instant BVUM_CEILING enforcement on debt create (rev 2).
 */
@Module({
  imports: [PrismaModule, CommonModule, BvumModule],
  controllers: [DebtsController],
  providers: [DebtsService],
})
export class DebtsModule {}
