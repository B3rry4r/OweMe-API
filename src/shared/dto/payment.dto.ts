import { IsInt, IsString, IsNotEmpty, Min } from 'class-validator';

/** POST /debts/:id/payments — idempotent on id. Partial allowed; overpayment -> 422. */
export class CreatePaymentDto {
  @IsString()
  @IsNotEmpty()
  id!: string; // client-minted UUIDv7

  @IsInt()
  @Min(1)
  amount!: number; // kobo

  @IsString()
  @IsNotEmpty()
  method!: string; // client label, recorded verbatim
}
