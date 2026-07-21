import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common';
import { WebhooksService, WebhookAck } from './webhooks.service';

/**
 * Inbound provider webhooks. BOTH routes are @Public: they bypass the global JwtAuthGuard
 * (there is no user JWT on a provider callback) and carry NO @Roles. The provider signature is
 * the sole trust boundary, enforced inside the service (invalid -> 401 via the error envelope).
 *
 * Paystack signs the RAW request body, so we read `req.rawBody` (Nest rawBody). When the raw
 * buffer is unavailable we fall back to a canonical re-serialization of the parsed body.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly service: WebhooksService) {}

  @Public()
  @Post('paystack')
  @HttpCode(200)
  paystack(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: Record<string, unknown>,
    @Headers('x-paystack-signature') signature?: string,
  ): Promise<WebhookAck> {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(body ?? {}));
    return this.service.handlePaystack(raw, body, signature);
  }

  @Public()
  @Post('iap')
  @HttpCode(200)
  iap(@Body() body: Record<string, unknown>): Promise<WebhookAck> {
    return this.service.handleIap(body);
  }
}
