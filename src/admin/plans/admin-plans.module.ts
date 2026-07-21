import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminCommonModule } from '../common';
import { AdminPlansController } from './admin-plans.controller';
import { AdminPlansService } from './admin-plans.service';

/**
 * Admin plan-catalog feature module. Aggregated by AdminModule only. Exports the
 * service so other admin modules (plan pickers, forced-plan flows) can read the
 * catalog without duplicating the projection.
 */
@Module({
  imports: [PrismaModule, AdminCommonModule],
  controllers: [AdminPlansController],
  providers: [AdminPlansService],
  exports: [AdminPlansService],
})
export class AdminPlansModule {}
