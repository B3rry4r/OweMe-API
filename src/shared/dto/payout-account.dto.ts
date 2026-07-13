import { IsString, IsNotEmpty, Length } from 'class-validator';

/** POST /payout-account/resolve — Paystack name lookup. */
export class ResolvePayoutAccountDto {
  @IsString()
  @IsNotEmpty()
  bankCode!: string;

  @IsString()
  @Length(10, 10)
  accountNumber!: string; // 10-digit NUBAN
}

/** PUT /payout-account — creates/updates the business's Paystack subaccount. */
export class UpdatePayoutAccountDto {
  @IsString()
  @IsNotEmpty()
  bankCode!: string;

  @IsString()
  @IsNotEmpty()
  accountNumber!: string;

  @IsString()
  @IsNotEmpty()
  accountName!: string;
}
