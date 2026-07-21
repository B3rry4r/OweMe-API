import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminCommonModule } from '../common';
import { AdminPayLinksController } from './admin-pay-links.controller';
import { AdminPayLinksService } from './admin-pay-links.service';
import { AdminWebhookEventsController } from './admin-webhook-events.controller';

/**
 * Pay-link money + webhook-log feature module (registry AdminPayLinksView).
 * Aggregated by AdminModule only. Read-only surface, so no AdminAuditModule import.
 */
@Module({
  imports: [PrismaModule, AdminCommonModule],
  controllers: [AdminPayLinksController, AdminWebhookEventsController],
  providers: [AdminPayLinksService],
})
export class AdminPayLinksModule {}
