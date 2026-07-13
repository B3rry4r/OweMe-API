import { Injectable } from '@nestjs/common';

export interface PaystackBank {
  code: string;
  name: string;
}

export interface ResolveAccountResult {
  accountName: string;
}

export interface CreateSubaccountInput {
  businessName: string;
  bankCode: string;
  accountNumber: string;
}

export interface CreateSubaccountResult {
  subaccountCode: string;
}

export interface PaymentRequestInput {
  amount: number; // kobo
  reference: string;
  subaccountCode: string | null;
  // Rev 2: flat platform commission (kobo) the MAIN account takes via the subaccount split.
  transactionCharge?: number;
  metadata?: Record<string, unknown>;
}

export interface PaymentRequestResult {
  url: string;
  reference: string;
}

/** PaystackGateway — banks / resolve / subaccount / transaction. FROZEN interface. */
export interface PaystackGateway {
  listBanks(): Promise<PaystackBank[]>;
  resolveAccount(bankCode: string, accountNumber: string): Promise<ResolveAccountResult>;
  createSubaccount(input: CreateSubaccountInput): Promise<CreateSubaccountResult>;
  createPaymentRequest(input: PaymentRequestInput): Promise<PaymentRequestResult>;
  verifySignature(rawBody: Buffer | string, signature: string): boolean;
}

/** Default stub — returns deterministic fixtures; verifies any signature. */
@Injectable()
export class StubPaystackGateway implements PaystackGateway {
  async listBanks(): Promise<PaystackBank[]> {
    return [
      { code: '044', name: 'Access Bank' },
      { code: '058', name: 'Guaranty Trust Bank' },
      { code: '057', name: 'Zenith Bank' },
    ];
  }

  async resolveAccount(bankCode: string, accountNumber: string): Promise<ResolveAccountResult> {
    return { accountName: `TEST ACCOUNT ${accountNumber}` };
  }

  async createSubaccount(input: CreateSubaccountInput): Promise<CreateSubaccountResult> {
    return { subaccountCode: `ACCT_stub_${input.accountNumber}` };
  }

  async createPaymentRequest(input: PaymentRequestInput): Promise<PaymentRequestResult> {
    return { url: `https://paystack.test/pay/${input.reference}`, reference: input.reference };
  }

  verifySignature(_rawBody: Buffer | string, _signature: string): boolean {
    return true;
  }
}
