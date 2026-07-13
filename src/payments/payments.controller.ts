import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { CreatePaymentDto, Payment, ReceiptResponse } from '../shared';
import { BusinessId, Roles } from '../common';
import { PaymentsService } from './payments.service';

/**
 * Payments — money received against debts. Tenant-scoped from the JWT businessId.
 *   POST /debts/:id/payments      -> 201 Payment (200 + existing when idempotent). owner|staff
 *   GET  /payments/:id            -> { payment, debt: DebtView, business } receipt.  owner|staff
 *   POST /debts/:id/undo-payment  -> Payment (the removed most-recent payment).      owner|staff
 *
 * Balance is derived from the payment sum (never stored); overpayment -> 422.
 */
@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('debts/:id/payments')
  @Roles('owner', 'staff')
  async create(
    @BusinessId() businessId: string,
    @Param('id') debtId: string,
    @Body() dto: CreatePaymentDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Payment> {
    const { payment, created } = await this.payments.create(businessId, debtId, dto);
    res.status(created ? 201 : 200); // idempotent re-POST returns the existing payment (200)
    return payment;
  }

  @Get('payments/:id')
  @Roles('owner', 'staff')
  getReceipt(
    @BusinessId() businessId: string,
    @Param('id') id: string,
  ): Promise<ReceiptResponse> {
    return this.payments.getReceipt(businessId, id);
  }

  @Post('debts/:id/undo-payment')
  @Roles('owner', 'staff')
  undo(@BusinessId() businessId: string, @Param('id') debtId: string): Promise<Payment> {
    return this.payments.undo(businessId, debtId);
  }
}
