import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminTokenService } from './admin-token.service';
import { AdminJwtGuard } from './admin-jwt.guard';
import { AdminRolesGuard } from './admin-roles.guard';

/**
 * Shared admin infrastructure: token service and guards. Imported by every
 * src/admin/<resource> module; NOT global and NOT registered as APP_GUARD -
 * admin guards are applied controller-level on /admin routes only, so the shipped
 * app surface is untouched. JwtService comes from the global CommonModule export.
 * The audit writer lives in AdminAuditModule (src/admin/audit/).
 */
@Module({
  imports: [PrismaModule],
  providers: [AdminTokenService, AdminJwtGuard, AdminRolesGuard],
  exports: [AdminTokenService, AdminJwtGuard, AdminRolesGuard],
})
export class AdminCommonModule {}
