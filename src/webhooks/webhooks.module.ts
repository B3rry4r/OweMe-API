import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CommonModule } from '../common/common.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

/**
 * Webhooks feature module: inbound provider callbacks (Paystack charges, IAP notifications).
 * Register in app.module: `WebhooksModule`.
 *
 * Imports:
 *   - CommonModule for the PAYSTACK_GATEWAY (HMAC verify) + RECEIPT_VERIFIER (IAP verify) providers.
 *
 * Both routes are @Public; provider-signature verification is the only trust boundary. IAP tenant
 * attribution comes from the BillingTransaction persisted at verify-receipt time, never the body.
 *
 * Note: bundle credits are granted ONLY at verify-receipt time (BillingModule); this module no
 * longer credits ledgers, so it does not import UsageModule.
 */
@Module({
  imports: [PrismaModule, CommonModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
