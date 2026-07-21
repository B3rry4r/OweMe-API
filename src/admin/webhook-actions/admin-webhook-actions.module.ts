import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { CommonModule } from '../../common/common.module';
import { WebhooksService } from '../../webhooks/webhooks.service';
import { AdminCommonModule } from '../common';
import { AdminAuditModule } from '../audit/admin-audit.module';
import { AdminWebhookActionsController } from './admin-webhook-actions.controller';
import { AdminWebhookActionsService } from './admin-webhook-actions.service';

/**
 * Webhook replay feature module (registry AdminWebhookActions). Aggregated by AdminModule only.
 *
 * WebhooksService is provided here rather than imported: the LIVE WebhooksModule keeps it
 * private (no exports), and widening that module would be an edit to protected surface. Nest
 * therefore constructs a second instance of the SAME class from the SAME injected providers -
 * the service is stateless, so replay runs through identical code and identical provider
 * selection (CommonModule owns PAYSTACK_GATEWAY and RECEIPT_VERIFIER). The live
 * POST /webhooks/* routes are untouched.
 */
@Module({
  imports: [PrismaModule, CommonModule, AdminCommonModule, AdminAuditModule],
  controllers: [AdminWebhookActionsController],
  providers: [AdminWebhookActionsService, WebhooksService],
})
export class AdminWebhookActionsModule {}
