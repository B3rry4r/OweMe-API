import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminCommonModule } from '../common';
import { AdminRemindersController } from './admin-reminders.controller';
import { AdminRemindersService } from './admin-reminders.service';

/**
 * Reminder-monitor feature module (read-only). Aggregated by AdminModule only.
 * The shipped reminder surface is untouched: this module owns no writes and
 * imports no app service, it reads Reminder/Business/usage_events directly.
 */
@Module({
  imports: [PrismaModule, AdminCommonModule],
  controllers: [AdminRemindersController],
  providers: [AdminRemindersService],
})
export class AdminRemindersModule {}
