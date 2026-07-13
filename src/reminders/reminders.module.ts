import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CommonModule } from '../common/common.module';
import { UsageModule } from '../usage/usage.module';
import { RemindersController } from './reminders.controller';
import { RemindersService } from './reminders.service';

/**
 * Reminders feature module — the actual scheduled/sent/failed Reminder rows + (stubbed)
 * delivery history. Register in app.module: `RemindersModule`.
 *
 * Imports:
 *   - CommonModule for the MESSAGE_SENDER delivery provider (stub / BulkSMSNigeria).
 *   - UsageModule for the exported SendAllowanceService.debitSend (SMS/WhatsApp metering).
 *
 * NOTE: the derived reminder-SCHEDULE card (-3/due/+3/+7) is owned by the Debt module
 * (GET /debts/:id/reminder-schedule) and is NOT duplicated here.
 */
@Module({
  imports: [PrismaModule, CommonModule, UsageModule],
  controllers: [RemindersController],
  providers: [RemindersService],
})
export class RemindersModule {}
