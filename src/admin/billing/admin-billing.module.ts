import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminCommonModule } from '../common';
import { AdminBillingController } from './admin-billing.controller';
import { AdminBillingService } from './admin-billing.service';

/**
 * Billing monitor feature module (registry AdminBillingView). Aggregated by
 * AdminModule only. Read-only: it queries prisma directly rather than importing the
 * protected BillingModule, so nothing on the app's entitlement path is touched.
 */
@Module({
  imports: [PrismaModule, AdminCommonModule],
  controllers: [AdminBillingController],
  providers: [AdminBillingService],
  exports: [AdminBillingService],
})
export class AdminBillingModule {}
