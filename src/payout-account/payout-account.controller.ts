import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { Bank, PayoutAccount, ResolvePayoutAccountDto, UpdatePayoutAccountDto } from '../shared';
import { Roles, BusinessId } from '../common';
import { PayoutAccountService } from './payout-account.service';

/**
 * PayoutAccount — Paystack payout setup. Owner-only surface; tenancy always from the JWT.
 *   GET  /banks                    -> Bank[] {code,name} (Paystack proxy).
 *   POST /payout-account/resolve   -> {accountName} (Paystack name lookup).
 *   GET  /payout-account           -> PayoutAccount | null for the business.
 *   PUT  /payout-account           -> PayoutAccount; builds subaccount + writes Business.paystackSubaccount.
 */
@Controller()
export class PayoutAccountController {
  constructor(private readonly payout: PayoutAccountService) {}

  @Get('banks')
  @Roles('owner')
  listBanks(): Promise<Bank[]> {
    return this.payout.listBanks();
  }

  @Post('payout-account/resolve')
  @Roles('owner')
  @HttpCode(200)
  resolve(@Body() dto: ResolvePayoutAccountDto): Promise<{ accountName: string }> {
    return this.payout.resolve(dto);
  }

  @Get('payout-account')
  @Roles('owner')
  get(@BusinessId() businessId: string): Promise<PayoutAccount | null> {
    return this.payout.get(businessId);
  }

  @Put('payout-account')
  @Roles('owner')
  upsert(
    @BusinessId() businessId: string,
    @Body() dto: UpdatePayoutAccountDto,
  ): Promise<PayoutAccount> {
    return this.payout.upsert(businessId, dto);
  }
}
