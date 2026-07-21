import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminCommonModule } from '../common';
import { AdminAuditController } from './admin-audit.controller';
import { AdminAuditService } from './admin-audit.service';

/**
 * Audit-log feature module. Aggregated by AdminModule only. Exports the shared
 * AdminAuditService write helper so every other src/admin/<resource> module can
 * append its admin_audit_log rows (import this module, inject the service).
 */
@Module({
  imports: [PrismaModule, AdminCommonModule],
  controllers: [AdminAuditController],
  providers: [AdminAuditService],
  exports: [AdminAuditService],
})
export class AdminAuditModule {}
