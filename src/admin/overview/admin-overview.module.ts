import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminCommonModule } from '../common';
import { AdminOverviewController } from './admin-overview.controller';
import { AdminOverviewService } from './admin-overview.service';

/**
 * Platform-overview feature module. Aggregated by AdminModule only. Read-only over
 * shipped tables, so it needs no audit writer and exports nothing.
 */
@Module({
  imports: [PrismaModule, AdminCommonModule],
  controllers: [AdminOverviewController],
  providers: [AdminOverviewService],
})
export class AdminOverviewModule {}
