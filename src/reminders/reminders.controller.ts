import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import {
  CreateReminderDto,
  ListRemindersQueryDto,
  Paginated,
  Reminder,
  ReminderListItem,
} from '../shared';
import { BusinessId, Roles } from '../common';
import { RemindersService } from './reminders.service';

/**
 * Reminders — the actual scheduled/sent/failed Reminder rows + (stubbed) delivery history.
 * Tenant-scoped from the JWT businessId.
 *   GET  /reminders            -> Paginated<Reminder + {debt, customer}> (status + cursor). owner|staff
 *   POST /reminders            -> 201 Reminder (200 + existing when idempotent).            owner|staff
 *   POST /reminders/:id/retry  -> 200 Reminder (failed rows only; re-attempt + re-meter).   owner|staff
 */
@Controller('reminders')
export class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  @Get()
  @Roles('owner', 'staff')
  list(
    @BusinessId() businessId: string,
    @Query() query: ListRemindersQueryDto,
  ): Promise<Paginated<ReminderListItem>> {
    return this.reminders.list(businessId, query);
  }

  @Post()
  @Roles('owner', 'staff')
  async create(
    @BusinessId() businessId: string,
    @Body() dto: CreateReminderDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Reminder> {
    const { reminder, created } = await this.reminders.create(businessId, dto);
    res.status(created ? 201 : 200); // idempotent re-POST returns the existing row (200)
    return reminder;
  }

  @Post(':id/retry')
  @Roles('owner', 'staff')
  @HttpCode(200)
  retry(@BusinessId() businessId: string, @Param('id') id: string): Promise<Reminder> {
    return this.reminders.retry(businessId, id);
  }
}
