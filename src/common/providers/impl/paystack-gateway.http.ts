import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CreateSubaccountInput,
  CreateSubaccountResult,
  PaymentRequestInput,
  PaymentRequestResult,
  PaystackBank,
  PaystackGateway,
  ResolveAccountResult,
} from '../paystack-gateway';

/**
 * Real Paystack HTTP implementation of the FROZEN PaystackGateway interface.
 *
 * Docs verified against Paystack's official API reference (2026-07):
 *  - List banks:        https://paystack.com/docs/api/miscellaneous/   (GET /bank)
 *  - Resolve account:   https://paystack.com/docs/api/verification/    (GET /bank/resolve)
 *  - Create subaccount: https://paystack.com/docs/api/subaccount/      (POST /subaccount)
 *  - Init transaction:  https://paystack.com/docs/api/transaction/     (POST /transaction/initialize)
 *  - Webhook signature: https://paystack.com/docs/payments/webhooks/   (HMAC SHA512, x-paystack-signature)
 *
 * Every Paystack REST response is the envelope `{ status: boolean, message: string, data: T }`.
 * Auth on every request is the header `Authorization: Bearer <secretKey>`.
 * Uses Node's global `fetch` (Node 22) — no extra npm deps.
 */
export class PaystackGatewayHttp implements PaystackGateway {
  private static readonly BASE_URL = 'https://api.paystack.co';

  constructor(private readonly secretKey: string) {}

  /**
   * GET /bank — list supported banks.
   * Docs: https://paystack.com/docs/api/miscellaneous/#bank
   * We scope to Nigeria / NGN, matching this product's payout market. The envelope's
   * `data` is an array of bank objects exposing (among others) `name` and `code`.
   */
  async listBanks(): Promise<PaystackBank[]> {
    const data = await this.request<Array<{ name: string; code: string }>>(
      'GET',
      '/bank?country=nigeria&currency=NGN',
    );
    return data.map((b) => ({ code: b.code, name: b.name }));
  }

  /**
   * GET /bank/resolve?account_number=&bank_code= — confirm an account belongs to a customer.
   * Docs: https://paystack.com/docs/api/verification/#resolve-account
   * `data` contains `account_number`, `account_name`, `bank_id`.
   */
  async resolveAccount(bankCode: string, accountNumber: string): Promise<ResolveAccountResult> {
    const qs = new URLSearchParams({
      account_number: accountNumber,
      bank_code: bankCode,
    }).toString();
    const data = await this.request<{ account_number: string; account_name: string }>(
      'GET',
      `/bank/resolve?${qs}`,
    );
    return { accountName: data.account_name };
  }

  /**
   * POST /subaccount — create a subaccount for split settlement.
   * Docs: https://paystack.com/docs/api/subaccount/#create
   * Required body fields: business_name, settlement_bank (bank code), account_number,
   * percentage_charge. The frozen input carries no split percentage, so we settle 100% of
   * each transaction to the subaccount owner (this is a pass-through payout to the payee;
   * the platform takes no cut). `data.subaccount_code` is returned (HTTP 201).
   */
  async createSubaccount(input: CreateSubaccountInput): Promise<CreateSubaccountResult> {
    const data = await this.request<{ subaccount_code: string }>('POST', '/subaccount', {
      business_name: input.businessName,
      settlement_bank: input.bankCode,
      account_number: input.accountNumber,
      percentage_charge: 100,
    });
    return { subaccountCode: data.subaccount_code };
  }

  /**
   * POST /transaction/initialize — create a hosted-checkout authorization URL.
   * Docs: https://paystack.com/docs/api/transaction/#initialize
   * `amount` is in kobo (NGN minor units). `email` is REQUIRED by Paystack, but the frozen
   * PaymentRequestInput has no email field and the signature must not change. We therefore
   * derive an email: use `metadata.email` when the caller supplies one, otherwise a stable
   * placeholder keyed on the reference. `subaccount` is only sent when a subaccount code is
   * present. Response `data` has `authorization_url`, `access_code`, `reference`.
   */
  async createPaymentRequest(input: PaymentRequestInput): Promise<PaymentRequestResult> {
    const metadataEmail =
      input.metadata && typeof input.metadata.email === 'string'
        ? (input.metadata.email as string)
        : undefined;
    const email = metadataEmail ?? `payments+${input.reference}@oweme.app`;

    const body: Record<string, unknown> = {
      email,
      amount: input.amount,
      reference: input.reference,
    };
    if (input.metadata !== undefined) body.metadata = input.metadata;
    if (input.subaccountCode !== null) body.subaccount = input.subaccountCode;

    const data = await this.request<{ authorization_url: string; reference: string }>(
      'POST',
      '/transaction/initialize',
      body,
    );
    return { url: data.authorization_url, reference: data.reference };
  }

  /**
   * Verify a Paystack webhook signature.
   * Docs: https://paystack.com/docs/payments/webhooks/
   * Signature = HMAC-SHA512(rawBody) hex-encoded, keyed with the secret key, delivered in the
   * `x-paystack-signature` header. Comparison is timing-safe. Never throws — returns false on
   * any malformed/empty input.
   */
  verifySignature(rawBody: Buffer | string, signature: string): boolean {
    try {
      if (typeof signature !== 'string' || signature.length === 0) return false;
      const expected = createHmac('sha512', this.secretKey).update(rawBody).digest('hex');
      const expectedBuf = Buffer.from(expected, 'utf8');
      const providedBuf = Buffer.from(signature, 'utf8');
      if (expectedBuf.length !== providedBuf.length) return false;
      return timingSafeEqual(expectedBuf, providedBuf);
    } catch {
      return false;
    }
  }

  /**
   * Issue an authenticated request and unwrap the Paystack `{status, message, data}` envelope.
   * Throws a clear Error on non-2xx HTTP or when `status` is false.
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${PaystackGatewayHttp.BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let payload: { status?: boolean; message?: string; data?: T } | null = null;
    try {
      payload = (await res.json()) as { status?: boolean; message?: string; data?: T };
    } catch {
      payload = null;
    }

    if (!res.ok) {
      const msg = payload?.message ?? res.statusText;
      throw new Error(`Paystack ${method} ${path} failed (HTTP ${res.status}): ${msg}`);
    }
    if (!payload || payload.status !== true) {
      const msg = payload?.message ?? 'unknown error';
      throw new Error(`Paystack ${method} ${path} returned status=false: ${msg}`);
    }
    return payload.data as T;
  }
}
