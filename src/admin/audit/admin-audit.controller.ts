import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Public } from '../../common';
import { AdminJwtGuard, AdminRoles, AdminRolesGuard } from '../common';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuditEntryView, AdminNameRef, Paged } from './admin-audit.views';
import { AuditLogQueryDto } from './dto/admin-audit.dto';

/**
 * Audit trail reads, superadmin + support (registry AdminAuditLog). APPEND-ONLY
 * invariant: this controller is GET-only by design - rows are written exclusively
 * by other endpoints through AdminAuditService.record(), never over HTTP.
 *   GET /admin/audit-log        -> 200 Paged<AdminAuditEntryView>.
 *   GET /admin/audit-log/admins -> 200 AdminNameRef[] (filter dropdown).
 */
@Controller('admin/audit-log')
@Public()
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles('superadmin', 'support')
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  @Get()
  list(@Query() query: AuditLogQueryDto): Promise<Paged<AdminAuditEntryView>> {
    return this.audit.list(query);
  }

  @Get('admins')
  admins(): Promise<AdminNameRef[]> {
    return this.audit.admins();
  }
}
