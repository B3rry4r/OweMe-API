import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminCommonModule } from '../common';
import { AdminAuditModule } from '../audit/admin-audit.module';
import { AdminAuthController, AdminSessionController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';

/** Admin auth (email + password) feature module. Aggregated by AdminModule only. */
@Module({
  imports: [PrismaModule, AdminCommonModule, AdminAuditModule],
  controllers: [AdminAuthController, AdminSessionController],
  providers: [AdminAuthService],
})
export class AdminAuthModule {}
