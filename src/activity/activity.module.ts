import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CommonModule } from '../common/common.module';
import { ActivityController } from './activity.controller';
import { ActivityService } from './activity.service';

/**
 * Activity (derived feed) module. Register in app.module: `ActivityModule`.
 * No own table — reads Debt/Payment/Reminder/Customer tables via PrismaService.
 */
@Module({
  imports: [PrismaModule, CommonModule],
  controllers: [ActivityController],
  providers: [ActivityService],
})
export class ActivityModule {}
