import { Injectable } from '@nestjs/common';
import { IapPlatform } from '../../shared';

export interface VerifyReceiptInput {
  platform: IapPlatform;
  productId: string;
  receipt: string;
}

export interface VerifyReceiptResult {
  valid: boolean;
  /** Store transaction id — used to make receipt processing idempotent. */
  transactionId: string;
  productId: string;
}

/** ReceiptVerifier — Apple/Google IAP receipt verification. FROZEN interface. */
export interface ReceiptVerifier {
  verify(input: VerifyReceiptInput): Promise<VerifyReceiptResult>;
}

/** Default stub — verifies any receipt as valid with a derived transaction id. */
@Injectable()
export class StubReceiptVerifier implements ReceiptVerifier {
  async verify(input: VerifyReceiptInput): Promise<VerifyReceiptResult> {
    return {
      valid: true,
      transactionId: `stub-txn-${input.receipt.slice(0, 16)}`,
      productId: input.productId,
    };
  }
}
