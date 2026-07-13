import { Module } from '@nestjs/common';
import { UsageModule } from '../usage/usage.module';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';

/**
 * Voice module — transcript parsing (no own table). Imports UsageModule for the exported
 * CreditLedgerService (debit-on-success). LLM_PROVIDER + guards come from the global
 * CommonModule; PrismaService from the global PrismaModule.
 */
@Module({
  imports: [UsageModule],
  controllers: [VoiceController],
  providers: [VoiceService],
})
export class VoiceModule {}
