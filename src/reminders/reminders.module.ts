import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CommonModule } from '../common/common.module';
import { UsageModule } from '../usage/usage.module';
import { RemindersController } from './reminders.controller';
import { RemindersService } from './reminders.service';
import { ReminderDispatchService } from './reminder-dispatch.service';

/**
 * Reminders feature module — the actual scheduled/sent/failed Reminder rows + (stubbed)
 * delivery history. Register in app.module: `RemindersModule`.
 *
 * Imports:
 *   - CommonModule for the MESSAGE_SENDER delivery provider (stub / BulkSMSNigeria).
 *   - UsageModule for the exported CreditLedgerService.debitCredits (unified-credit metering).
 *
 * Also hosts ReminderDispatchService: the per-minute cron worker that claims due 'scheduled'
 * rows and delivers them (requires ScheduleModule.forRoot() in app.module for the cron to fire).
 *
 * NOTE: the derived reminder-SCHEDULE card (-3/due/+3/+7) is owned by the Debt module
 * (GET /debts/:id/reminder-schedule) and is NOT duplicated here.
 */
@Module({
  imports: [PrismaModule, CommonModule, UsageModule],
  controllers: [RemindersController],
  providers: [RemindersService, ReminderDispatchService],
})
export class RemindersModule {}
