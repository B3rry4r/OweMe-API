import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminCommonModule } from '../common';
import { AdminDebtsController } from './admin-debts.controller';
import { AdminDebtsService } from './admin-debts.service';
import { AdminPaymentsController } from './admin-payments.controller';

/**
 * Debts + payments monitor feature module (registry AdminDebtsView). Aggregated by
 * AdminModule only. Read-only: no audit writes, so AdminAuditModule is not imported.
 */
@Module({
  imports: [PrismaModule, AdminCommonModule],
  controllers: [AdminDebtsController, AdminPaymentsController],
  providers: [AdminDebtsService],
})
export class AdminDebtsModule {}
