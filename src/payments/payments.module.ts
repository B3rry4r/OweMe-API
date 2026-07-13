import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CommonModule } from '../common/common.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * Payments feature module. Register in app.module: `PaymentsModule`.
 * Reads the Debt/Customer/Business tables via Prisma (money/balance derived, never stored).
 */
@Module({
  imports: [PrismaModule, CommonModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
