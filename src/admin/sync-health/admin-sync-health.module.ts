import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminCommonModule } from '../common';
import { AdminSyncHealthController } from './admin-sync-health.controller';
import { AdminSyncHealthService } from './admin-sync-health.service';

/**
 * Sync-health feature module. Aggregated by AdminModule only. Read-only resource:
 * it needs no AdminAuditModule because it writes nothing (registry auditLogged: false).
 */
@Module({
  imports: [PrismaModule, AdminCommonModule],
  controllers: [AdminSyncHealthController],
  providers: [AdminSyncHealthService],
})
export class AdminSyncHealthModule {}
