import { Module } from '@nestjs/common';
import { InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';

/**
 * Insights (AI dashboard) feature module. Register in app.module: `InsightsModule`.
 *
 * 501 scaffold — no own table, no PrismaModule needed yet. When the live path ships it will
 * import UsageModule (CreditLedgerService) and consume LLM_PROVIDER from CommonModule.
 */
@Module({
  controllers: [InsightsController],
  providers: [InsightsService],
})
export class InsightsModule {}
