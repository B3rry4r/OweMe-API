import { Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { Public } from '../../common';
import {
  AdminJwtGuard,
  AdminPrincipal,
  AdminRoles,
  AdminRolesGuard,
  CurrentAdmin,
} from '../common';
import { AdminReminderActionsService } from './admin-reminder-actions.service';
import { AdminReminderView } from './admin-reminder-actions.views';

/**
 * Reminder support actions (registry AdminReminderActions). Conventions-approved for
 * support as well as superadmin: retrying a failed reminder is issue resolution, not
 * billing or a destructive action.
 *   POST /admin/reminders/:id/retry -> 200 AdminReminderView
 *                                    | 404 NOT_FOUND
 *                                    | 422 VALIDATION_ERROR (row not failed, or whatsapp)
 *                                    | 403 PLAN_REQUIRED (target business out of credits).
 *
 * 200 (not 201) mirrors the app's POST /reminders/:id/retry: the row is updated, not created.
 * The read-only monitor routes live on AdminRemindersController under the same path prefix.
 */
@Controller('admin/reminders')
@Public()
@UseGuards(AdminJwtGuard, AdminRolesGuard)
@AdminRoles('superadmin', 'support')
export class AdminReminderActionsController {
  constructor(private readonly reminderActions: AdminReminderActionsService) {}

  @Post(':id/retry')
  @HttpCode(200)
  retry(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
  ): Promise<AdminReminderView> {
    return this.reminderActions.retry(actor, id);
  }
}
