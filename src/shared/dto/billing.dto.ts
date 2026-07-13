import { IsIn, IsString, IsNotEmpty } from 'class-validator';
import { IAP_PLATFORM_VALUES, IapPlatform } from '../enums';

/** POST /billing/verify-receipt — verifies with Apple/Google, routes by productId. Idempotent on store txn id. */
export class VerifyReceiptDto {
  @IsIn(IAP_PLATFORM_VALUES)
  platform!: IapPlatform;

  @IsString()
  @IsNotEmpty()
  productId!: string;

  @IsString()
  @IsNotEmpty()
  receipt!: string;
}
