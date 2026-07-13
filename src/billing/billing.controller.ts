import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  BillingTransaction,
  Paginated,
  PaginationQueryDto,
  Subscription,
  VerifyReceiptDto,
} from '../shared';
import { BusinessId, Roles } from '../common';
import { BillingService, VerifyReceiptResponse } from './billing.service';

/**
 * Billing / Subscription — owner-only, tenant-scoped IAP surface (registry contract).
 *   GET  /subscription            -> current entitlement (defaults to starter/none)
 *   POST /billing/verify-receipt  -> verify + route by productId (plan | bundle), idempotent
 *   GET  /billing/history         -> Paginated<BillingTransaction>
 * Server is the SOLE entitlement authority; the client is display-only.
 */
@Controller()
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('subscription')
  @Roles('owner')
  getSubscription(@BusinessId() businessId: string): Promise<Subscription> {
    return this.billing.getSubscription(businessId);
  }

  @Post('billing/verify-receipt')
  @Roles('owner')
  verifyReceipt(
    @BusinessId() businessId: string,
    @Body() dto: VerifyReceiptDto,
  ): Promise<VerifyReceiptResponse> {
    return this.billing.verifyReceipt(businessId, dto);
  }

  @Get('billing/history')
  @Roles('owner')
  getHistory(
    @BusinessId() businessId: string,
    @Query() query: PaginationQueryDto,
  ): Promise<Paginated<BillingTransaction>> {
    return this.billing.getHistory(businessId, query.cursor, query.limit);
  }
}
