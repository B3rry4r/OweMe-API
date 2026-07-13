import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CommonModule } from '../common/common.module';
import { DebtsController } from './debts.controller';
import { DebtsService } from './debts.service';

/**
 * Debts (receivables ledger) feature module. Register in app.module: `DebtsModule`.
 * Imports CommonModule for the PAYSTACK_GATEWAY provider (pay-link).
 */
@Module({
  imports: [PrismaModule, CommonModule],
  controllers: [DebtsController],
  providers: [DebtsService],
})
export class DebtsModule {}
