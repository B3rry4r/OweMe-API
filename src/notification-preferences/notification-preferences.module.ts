import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationPreferencesController } from './notification-preferences.controller';
import { NotificationPreferencesService } from './notification-preferences.service';

/**
 * NotificationPreferences feature module.
 * Register in app.module: `NotificationPreferencesModule`.
 */
@Module({
  imports: [PrismaModule],
  controllers: [NotificationPreferencesController],
  providers: [NotificationPreferencesService],
})
export class NotificationPreferencesModule {}
