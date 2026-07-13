import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CommonModule } from '../common/common.module';
import { UsageModule } from '../usage/usage.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

/**
 * Webhooks feature module — inbound provider callbacks (Paystack charges, IAP notifications).
 * Register in app.module: `WebhooksModule`.
 *
 * Imports:
 *   - CommonModule for the PAYSTACK_GATEWAY (HMAC verify) + RECEIPT_VERIFIER (IAP verify) providers.
 *   - UsageModule for the exported SendAllowanceService / CreditLedgerService (out-of-band bundle credits).
 *
 * Both routes are @Public; provider-signature verification is the only trust boundary.
 */
@Module({
  imports: [PrismaModule, CommonModule, UsageModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
