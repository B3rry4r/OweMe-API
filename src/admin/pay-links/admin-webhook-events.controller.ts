import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Public } from '../../common';
import { AdminJwtGuard, AdminRoles, AdminRolesGuard } from '../common';
import { AdminPayLinksService } from './admin-pay-links.service';
import { AdminWebhookEventsView } from './admin-pay-links.views';
import { WebhookEventsQueryDto } from './dto/admin-pay-links.dto';

/**
 * Webhook delivery log, superadmin + support (registry AdminPayLinksView). It sits
 * beside the pay-link reads because it is the same operator surface: the Paystack
 * webhook is what settles a pay-link.
 *   GET /admin/webhooks/events -> 200 Paged<AdminWebhookEventView> + errorCount.
 */
@Controller('admin/webhooks')
@Public()
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles('superadmin', 'support')
export class AdminWebhookEventsController {
  constructor(private readonly payLinks: AdminPayLinksService) {}

  @Get('events')
  events(@Query() query: WebhookEventsQueryDto): Promise<AdminWebhookEventsView> {
    return this.payLinks.webhookEvents(query);
  }
}
