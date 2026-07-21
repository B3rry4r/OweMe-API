import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminCommonModule } from '../common';
import { AdminAuditModule } from '../audit/admin-audit.module';
import { AdminOtpRevealController } from './admin-otp-reveal.controller';
import { AdminOtpRevealService } from './admin-otp-reveal.service';

/**
 * Test-account OTP reveal feature module (registry AdminOtpReveal, conventions
 * power 2). Aggregated by AdminModule only. Imports AdminAuditModule because every
 * reveal attempt - granted or refused - appends an admin_audit_log row; no other
 * table is written.
 */
@Module({
  imports: [PrismaModule, AdminCommonModule, AdminAuditModule],
  controllers: [AdminOtpRevealController],
  providers: [AdminOtpRevealService],
  exports: [AdminOtpRevealService],
})
export class AdminOtpRevealModule {}
