import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { Public } from '../../common';
import {
  AdminJwtGuard,
  AdminPrincipal,
  AdminRoles,
  AdminRolesGuard,
  CurrentAdmin,
} from '../common';
import { AdminWebhookActionsService } from './admin-webhook-actions.service';
import { AdminWebhookEventView } from './admin-webhook-actions.views';

/**
 * Webhook replay action, superadmin + support (registry AdminWebhookActions; the
 * conventions role matrix lets support replay a webhook). It shares the /admin/webhooks
 * prefix with the read-only log controller in AdminPayLinksView, which owns the GET.
 *   POST /admin/webhooks/events/:id/replay -> AdminWebhookEventView (the appended row)
 *        | 404 NOT_FOUND (unknown event)
 *        | 422 VALIDATION_ERROR (outcome is not 'error', nothing replayable retained,
 *              or the re-delivery itself failed).
 * Audit-logged on every call, including a failed re-delivery.
 */
@Controller('admin/webhooks')
@Public()
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles('superadmin', 'support')
export class AdminWebhookActionsController {
  constructor(private readonly actions: AdminWebhookActionsService) {}

  @Post('events/:id/replay')
  replay(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
  ): Promise<AdminWebhookEventView> {
    return this.actions.replay(actor, id);
  }
}
