import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminCommonModule } from '../common';
import { AdminAiUsageController } from './admin-ai-usage.controller';
import { AdminAiUsageService } from './admin-ai-usage.service';

/**
 * AI-usage feature module (registry AdminAiUsageView). Aggregated by AdminModule only.
 * Read-only over usage_events, so it needs no AdminAuditModule import.
 */
@Module({
  imports: [PrismaModule, AdminCommonModule],
  controllers: [AdminAiUsageController],
  providers: [AdminAiUsageService],
  exports: [AdminAiUsageService],
})
export class AdminAiUsageModule {}
