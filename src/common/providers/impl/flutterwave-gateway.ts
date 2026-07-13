import { timingSafeEqual } from 'node:crypto';
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
 * Real Flutterwave HTTP implementation of the FROZEN `PaystackGateway` interface.
 *
 * The interface is named "PaystackGateway", but this class is a Flutterwave backend of the
 * SAME contract — the provider dispatcher (see common.module) selects Paystack vs Flutterwave
 * by env, so both implementations must satisfy the identical method surface.
 *
 * API GENERATION: Flutterwave **v3** (`https://api.flutterwave.com/v3`).
 * v3 is the current stable/production API as of 2026-07; the newer v4 is still Public Beta
 * (OAuth 2.0, different envelope) and not yet GA, so we target v3 consistently.
 * Docs: https://developer.flutterwave.com/docs  •  versioning: https://developer.flutterwave.com/docs/versioning
 *
 * Endpoints verified against the official v3 reference (2026-07):
 *  - List banks (NG):   GET  /banks/NG          https://developer.flutterwave.com/v3.0/reference/get-all-banks
 *  - Resolve account:   POST /accounts/resolve  https://developer.flutterwave.com/reference/bank_account_resolve_post
 *  - Create subaccount: POST /subaccounts       https://developer.flutterwave.com/v3.0/reference/create-a-sub-account
 *  - Initiate payment:  POST /payments          https://developer.flutterwave.com/v3.0/docs/flutterwave-standard-1
 *  - Webhook verify:    `verif-hash` header      https://developer.flutterwave.com/docs/webhooks
 *
 * Envelope: every v3 REST response is `{ status: "success" | ..., message: string, data: T }`.
 * Auth: every request carries `Authorization: Bearer <FLUTTERWAVE_SECRET_KEY>`.
 * Uses Node 22's global `fetch` — no extra npm deps.
 *
 * CURRENCY / UNITS: the frozen `PaymentRequestInput.amount` is in **kobo** (NGN minor units,
 * Paystack's convention). Flutterwave v3 expects amounts in **major units (naira)**, so we
 * divide by 100 at the boundary in `createPaymentRequest` (see the kobo->naira note there).
 */
export class FlutterwaveGateway implements PaystackGateway {
  private static readonly BASE_URL = 'https://api.flutterwave.com/v3';

  /**
   * @param secretKey          Flutterwave secret key (FLWSECK...) used as the Bearer token.
   * @param webhookSecretHash  The "secret hash" you configure on the Flutterwave dashboard.
   *                           Flutterwave echoes this exact string back in the `verif-hash`
   *                           header of every webhook (see `verifySignature`).
   */
  constructor(
    private readonly secretKey: string,
    private readonly webhookSecretHash: string,
  ) {}

  /**
   * GET /banks/NG — list supported Nigerian banks.
   * Docs: https://developer.flutterwave.com/v3.0/reference/get-all-banks
   * `data` is an array of bank objects exposing (among others) `id`, `code`, `name`.
   * We scope to Nigeria (NG) matching this product's payout market.
   */
  async listBanks(): Promise<PaystackBank[]> {
    const data = await this.request<Array<{ code: string; name: string }>>('GET', '/banks/NG');
    return data.map((b) => ({ code: b.code, name: b.name }));
  }

  /**
   * POST /accounts/resolve — confirm an account number belongs to a customer.
   * Docs: https://developer.flutterwave.com/reference/bank_account_resolve_post
   * Body: `account_number`, `account_bank` (the bank *code*). `data` returns `account_name`.
   */
  async resolveAccount(bankCode: string, accountNumber: string): Promise<ResolveAccountResult> {
    const data = await this.request<{ account_number: string; account_name: string }>(
      'POST',
      '/accounts/resolve',
      {
        account_number: accountNumber,
        account_bank: bankCode,
      },
    );
    return { accountName: data.account_name };
  }

  /**
   * POST /subaccounts — create a collection subaccount for split settlement.
   * Docs: https://developer.flutterwave.com/v3.0/reference/create-a-sub-account
   * Required body: account_bank (bank code), account_number, business_name, split_type,
   * split_value. The frozen input carries no split percentage, so we settle the FULL amount
   * to the subaccount owner (a pass-through payout to the payee; the platform takes no cut):
   * `split_type: 'percentage'` with `split_value: 1` = 100% to the subaccount.
   * Response `data.subaccount_id` (e.g. "RS_...") is the reference used when charging.
   */
  async createSubaccount(input: CreateSubaccountInput): Promise<CreateSubaccountResult> {
    const data = await this.request<{ subaccount_id: string }>('POST', '/subaccounts', {
      account_bank: input.bankCode,
      account_number: input.accountNumber,
      business_name: input.businessName,
      country: 'NG',
      split_type: 'percentage',
      split_value: 1,
    });
    return { subaccountCode: data.subaccount_id };
  }

  /**
   * POST /payments — create a Flutterwave Standard hosted-checkout link.
   * Docs: https://developer.flutterwave.com/v3.0/docs/flutterwave-standard-1
   *
   * kobo -> naira: the frozen `amount` is in kobo (NGN minor units); Flutterwave v3 expects
   * major units (naira), so we divide by 100 here.
   *
   * Flutterwave requires `tx_ref`, `amount`, `currency`, `redirect_url` and a `customer` object
   * with an email. The frozen `PaymentRequestInput` has neither email nor redirect_url and its
   * signature must not change, so we derive both: prefer `metadata.email` / `metadata.redirect_url`
   * when the caller supplies them, otherwise fall back to stable placeholders keyed on the
   * reference. `subaccounts` is only sent when a subaccount code is present — the split ratio was
   * fixed at subaccount creation, so passing just `{ id }` uses that default 100% split.
   * Response `data.link` is the hosted checkout URL; we echo the caller's `tx_ref` back.
   */
  async createPaymentRequest(input: PaymentRequestInput): Promise<PaymentRequestResult> {
    const meta = input.metadata;
    const email =
      meta && typeof meta.email === 'string'
        ? (meta.email as string)
        : `payments+${input.reference}@oweme.app`;
    const redirectUrl =
      meta && typeof meta.redirect_url === 'string'
        ? (meta.redirect_url as string)
        : `https://oweme.app/payments/callback?tx_ref=${encodeURIComponent(input.reference)}`;

    const body: Record<string, unknown> = {
      tx_ref: input.reference,
      amount: input.amount / 100, // kobo -> naira
      currency: 'NGN',
      redirect_url: redirectUrl,
      customer: { email },
    };
    if (input.metadata !== undefined) body.meta = input.metadata;
    if (input.subaccountCode !== null) body.subaccounts = [{ id: input.subaccountCode }];

    const data = await this.request<{ link: string }>('POST', '/payments', body);
    return { url: data.link, reference: input.reference };
  }

  /**
   * Verify a Flutterwave webhook.
   * Docs: https://developer.flutterwave.com/docs/webhooks
   *
   * Unlike Paystack (HMAC of the body), Flutterwave v3 does NOT sign the payload. It sends the
   * plaintext "secret hash" you configured on the dashboard back in the `verif-hash` header.
   * Verification is therefore a direct equality check between that header value (`signature`)
   * and our configured `webhookSecretHash` — done timing-safe. `rawBody` is unused for
   * Flutterwave (nothing is derived from it), but is kept to satisfy the frozen signature.
   * Never throws — returns false on any empty/mismatched/garbage input.
   */
  verifySignature(_rawBody: Buffer | string, signature: string): boolean {
    try {
      if (typeof signature !== 'string' || signature.length === 0) return false;
      const providedBuf = Buffer.from(signature, 'utf8');
      const expectedBuf = Buffer.from(this.webhookSecretHash, 'utf8');
      if (providedBuf.length !== expectedBuf.length) return false;
      return timingSafeEqual(providedBuf, expectedBuf);
    } catch {
      return false;
    }
  }

  /**
   * Issue an authenticated request and unwrap the Flutterwave `{status, message, data}` envelope.
   * Throws a clear Error on non-2xx HTTP or when `status !== 'success'`.
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${FlutterwaveGateway.BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let payload: { status?: string; message?: string; data?: T } | null = null;
    try {
      payload = (await res.json()) as { status?: string; message?: string; data?: T };
    } catch {
      payload = null;
    }

    if (!res.ok) {
      const msg = payload?.message ?? res.statusText;
      throw new Error(`Flutterwave ${method} ${path} failed (HTTP ${res.status}): ${msg}`);
    }
    if (!payload || payload.status !== 'success') {
      const msg = payload?.message ?? 'unknown error';
      throw new Error(`Flutterwave ${method} ${path} returned status!=success: ${msg}`);
    }
    return payload.data as T;
  }
}
