import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminCommonModule } from '../common';
import { AdminAuthMonitorController } from './admin-auth-monitor.controller';
import { AdminAuthMonitorService } from './admin-auth-monitor.service';

/**
 * Auth-monitor feature module (registry AdminAuthMonitorView). Aggregated by
 * AdminModule only. Read-only: no audit writer is injected because the resource has
 * no write endpoint.
 */
@Module({
  imports: [PrismaModule, AdminCommonModule],
  controllers: [AdminAuthMonitorController],
  providers: [AdminAuthMonitorService],
  exports: [AdminAuthMonitorService],
})
export class AdminAuthMonitorModule {}
