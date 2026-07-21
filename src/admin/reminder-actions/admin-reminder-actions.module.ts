import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { UsageModule } from '../../usage/usage.module';
import { RemindersService } from '../../reminders/reminders.service';
import { AdminCommonModule } from '../common';
import { AdminAuditModule } from '../audit/admin-audit.module';
import { AdminReminderActionsController } from './admin-reminder-actions.controller';
import { AdminReminderActionsService } from './admin-reminder-actions.service';

/**
 * Reminder support-actions feature module. Aggregated by AdminModule only.
 *
 * The LIVE RemindersService is registered as a provider (RemindersModule keeps it
 * internal and is protected surface, so it cannot be asked to export it). This is a
 * deliberate reuse, not a fork: the admin retry runs the trader-facing code path with
 * its credit debit, its dispatch and its refusals, and the class is stateless so a
 * second instance behaves identically. Its dependencies come from UsageModule
 * (CreditLedgerService) and the global CommonModule (MESSAGE_SENDER).
 */
@Module({
  imports: [PrismaModule, UsageModule, AdminCommonModule, AdminAuditModule],
  controllers: [AdminReminderActionsController],
  providers: [AdminReminderActionsService, RemindersService],
})
export class AdminReminderActionsModule {}
