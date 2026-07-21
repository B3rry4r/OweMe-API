import { Module } from '@nestjs/common';
import { AdminCommonModule } from './common';
import { AdminAuditModule } from './audit/admin-audit.module';
import { AdminAuthModule } from './auth/admin-auth.module';
import { AdminUsersModule } from './admin-users/admin-users.module';

/**
 * The ONE admin aggregation module (conventions: single app.module.ts registration
 * line for the whole admin surface). Wave agents add their src/admin/<resource>
 * modules HERE, never to app.module.ts. All routes live under /admin/* behind the
 * controller-level admin guards; the shipped app surface is untouched.
 */
@Module({
  imports: [
    AdminCommonModule,
    // Wave 1:
    AdminAuditModule,
    AdminAuthModule,
    AdminUsersModule,
  ],
})
export class AdminModule {}
