import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { UsageModule } from '../../usage/usage.module';
import { AdminCommonModule } from '../common';
import { AdminAuditModule } from '../audit/admin-audit.module';
import { AdminBusinessesModule } from '../businesses/admin-businesses.module';
import { AdminBusinessActionsController } from './admin-business-actions.controller';
import { AdminBusinessActionsService } from './admin-business-actions.service';

/**
 * Business write-actions feature module. Aggregated by AdminModule only.
 *
 * Imports the LIVE UsageModule solely for its exported CreditLedgerService, so admin
 * credit grants use the same increment/carry-over semantics as a purchased bundle, and
 * the wave-2 AdminBusinessesModule for its exported service, so every action answers with
 * exactly the view the monitor already renders (one derivation, no drift).
 */
@Module({
  imports: [PrismaModule, AdminCommonModule, AdminAuditModule, AdminBusinessesModule, UsageModule],
  controllers: [AdminBusinessActionsController],
  providers: [AdminBusinessActionsService],
})
export class AdminBusinessActionsModule {}
