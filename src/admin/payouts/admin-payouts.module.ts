import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminCommonModule } from '../common';
import { AdminPayoutsController } from './admin-payouts.controller';
import { AdminPayoutsService } from './admin-payouts.service';

/**
 * Payout-account monitor feature module (read-only). Aggregated by AdminModule
 * only. PAYSTACK_GATEWAY (the live GET /banks source) comes from the global
 * CommonModule export, so the protected payout write path stays untouched.
 */
@Module({
  imports: [PrismaModule, AdminCommonModule],
  controllers: [AdminPayoutsController],
  providers: [AdminPayoutsService],
})
export class AdminPayoutsModule {}
