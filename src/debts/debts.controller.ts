import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import {
  CreateDebtDto,
  DebtView,
  ListDebtsQueryDto,
  Paginated,
  PayLink,
  Payment,
  Reminder,
  ReminderScheduleStep,
  UpdateDebtDto,
} from '../shared';
import { BusinessId, Roles, parseIfMatchVersion } from '../common';
import { DebtsService } from './debts.service';

/**
 * Debts — receivables ledger. Tenant-scoped from the JWT businessId.
 *   GET    /debts                       -> Paginated<DebtView> (status/sort/q + cursor). owner|staff
 *   GET    /debts/:id                   -> DebtView (404 if not in tenant).              owner|staff
 *   POST   /debts                       -> 201 DebtView (200 + existing when idempotent). owner|staff
 *   PATCH  /debts/:id                   -> DebtView (If-Match version -> 409).            owner|staff
 *   DELETE /debts/:id                   -> DebtView (soft delete).                        OWNER-only
 *   POST   /debts/:id/restore           -> DebtView (un-archive).                         owner|staff
 *   POST   /debts/:id/pay-link          -> PayLink {url} (Paystack payment request).      owner|staff
 *   GET    /debts/:id/payments          -> Payment[] (newest-first).                      owner|staff
 *   GET    /debts/:id/reminders         -> Reminder[] (history timeline).                 owner|staff
 *   GET    /debts/:id/reminder-schedule -> ReminderScheduleStep[] (derived from dueDate). owner|staff
 */
@Controller('debts')
export class DebtsController {
  constructor(private readonly debts: DebtsService) {}

  @Get()
  @Roles('owner', 'staff')
  list(
    @BusinessId() businessId: string,
    @Query() query: ListDebtsQueryDto,
  ): Promise<Paginated<DebtView>> {
    return this.debts.list(businessId, query);
  }

  @Get(':id')
  @Roles('owner', 'staff')
  getOne(@BusinessId() businessId: string, @Param('id') id: string): Promise<DebtView> {
    return this.debts.getOne(businessId, id);
  }

  @Post()
  @Roles('owner', 'staff')
  async create(
    @BusinessId() businessId: string,
    @Body() dto: CreateDebtDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DebtView> {
    const { view, created } = await this.debts.create(businessId, dto);
    res.status(created ? 201 : 200); // idempotent re-POST returns the existing view (200)
    return view;
  }

  @Patch(':id')
  @Roles('owner', 'staff')
  update(
    @BusinessId() businessId: string,
    @Param('id') id: string,
    @Body() dto: UpdateDebtDto,
    @Headers('if-match') ifMatch?: string,
  ): Promise<DebtView> {
    return this.debts.update(businessId, id, dto, parseIfMatchVersion(ifMatch));
  }

  @Delete(':id')
  @Roles('owner')
  remove(@BusinessId() businessId: string, @Param('id') id: string): Promise<DebtView> {
    return this.debts.remove(businessId, id);
  }

  @Post(':id/restore')
  @Roles('owner', 'staff')
  restore(@BusinessId() businessId: string, @Param('id') id: string): Promise<DebtView> {
    return this.debts.restore(businessId, id);
  }

  @Post(':id/pay-link')
  @Roles('owner', 'staff')
  payLink(@BusinessId() businessId: string, @Param('id') id: string): Promise<PayLink> {
    return this.debts.payLink(businessId, id);
  }

  @Get(':id/payments')
  @Roles('owner', 'staff')
  payments(@BusinessId() businessId: string, @Param('id') id: string): Promise<Payment[]> {
    return this.debts.payments(businessId, id);
  }

  @Get(':id/reminders')
  @Roles('owner', 'staff')
  reminders(@BusinessId() businessId: string, @Param('id') id: string): Promise<Reminder[]> {
    return this.debts.reminders(businessId, id);
  }

  @Get(':id/reminder-schedule')
  @Roles('owner', 'staff')
  reminderSchedule(
    @BusinessId() businessId: string,
    @Param('id') id: string,
  ): Promise<ReminderScheduleStep[]> {
    return this.debts.reminderSchedule(businessId, id);
  }
}
