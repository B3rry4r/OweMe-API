/**
 * IapReceiptVerifier — REAL Apple + Google in-app-purchase receipt verification.
 *
 * Implements the FROZEN `ReceiptVerifier` interface from '../receipt-verifier'.
 * Uses ONLY global `fetch` (Node 22) and `node:crypto` — no npm deps added.
 *
 * ── Apple (legacy verifyReceipt, auto-renewable subscriptions via SHARED SECRET) ──
 * Docs: https://developer.apple.com/documentation/appstorereceipts/verifyreceipt
 *       https://developer.apple.com/documentation/appstorereceipts/status
 * Endpoints:
 *   production https://buy.itunes.apple.com/verifyReceipt
 *   sandbox    https://sandbox.itunes.apple.com/verifyReceipt
 * POST body: { "receipt-data": <base64>, "password": <sharedSecret>, "exclude-old-transactions": true }
 * Status codes we care about (per the `status` doc):
 *   0     — receipt is valid
 *   21007 — receipt is from the SANDBOX but was sent to PRODUCTION → retry against sandbox
 *   21008 — receipt is from PRODUCTION but was sent to SANDBOX → retry against production
 *   (any other non-zero) — not valid
 * NOTE: Apple has DEPRECATED verifyReceipt in favour of the App Store Server API, but the
 * endpoint still functions for legacy shared-secret flows, which is what this app uses.
 *
 * ── Google Play (Developer API, SERVICE ACCOUNT JSON) ──
 * Auth docs:   https://developers.google.com/identity/protocols/oauth2/service-account
 * API docs:    https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptions
 * 1. Mint an OAuth2 access token: sign an RS256 JWT with the service-account private key
 *    (iss=client_email, scope=https://www.googleapis.com/auth/androidpublisher,
 *     aud=https://oauth2.googleapis.com/token, iat=now, exp=now+3600), then
 *    POST https://oauth2.googleapis.com/token
 *      grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer & assertion=<jwt>
 * 2. GET https://androidpublisher.googleapis.com/androidpublisher/v3/applications/
 *      {packageName}/purchases/subscriptions/{subscriptionId}/tokens/{token}
 *    with Authorization: Bearer <access_token>.
 *    Valid when paymentState is 1 (received) or 2 (free trial). orderId → transactionId.
 */
import { createSign } from 'node:crypto';
import { IapPlatform } from '../../../shared';
import {
  ReceiptVerifier,
  VerifyReceiptInput,
  VerifyReceiptResult,
} from '../receipt-verifier';

// ── Apple ────────────────────────────────────────────────────────────────────
const APPLE_PROD_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_SANDBOX_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';
const APPLE_STATUS_VALID = 0;
const APPLE_STATUS_SANDBOX_RECEIPT = 21007; // sandbox receipt sent to production → retry sandbox
const APPLE_STATUS_PROD_RECEIPT = 21008; // production receipt sent to sandbox → retry production

interface AppleInAppEntry {
  transaction_id?: string;
  original_transaction_id?: string;
  product_id?: string;
}
interface AppleVerifyResponse {
  status: number;
  receipt?: { in_app?: AppleInAppEntry[] };
  latest_receipt_info?: AppleInAppEntry[];
}

// ── Google ───────────────────────────────────────────────────────────────────
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_ANDROIDPUBLISHER_BASE =
  'https://androidpublisher.googleapis.com/androidpublisher/v3';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const GOOGLE_JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
// paymentState: 0 pending, 1 received, 2 free-trial, 3 deferred. 1 & 2 → an active/paid purchase.
const GOOGLE_PAYMENT_STATE_RECEIVED = 1;
const GOOGLE_PAYMENT_STATE_FREE_TRIAL = 2;

interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
}
interface GoogleSubscriptionPurchase {
  paymentState?: number;
  orderId?: string;
  expiryTimeMillis?: string;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export class IapReceiptVerifier implements ReceiptVerifier {
  constructor(
    private readonly appleSharedSecret: string,
    private readonly googleServiceAccountJson: string,
    private readonly googlePackageName: string,
  ) {}

  async verify(input: VerifyReceiptInput): Promise<VerifyReceiptResult> {
    const platform: IapPlatform = input.platform;
    if (platform === 'ios') {
      return this.verifyApple(input);
    }
    if (platform === 'android') {
      return this.verifyGoogle(input);
    }
    throw new Error(`IapReceiptVerifier: unsupported platform '${platform as string}'`);
  }

  // ── Apple ──────────────────────────────────────────────────────────────────
  private async verifyApple(input: VerifyReceiptInput): Promise<VerifyReceiptResult> {
    // Try production first; on 21007 the receipt is a sandbox receipt → retry sandbox.
    let response = await this.callApple(APPLE_PROD_URL, input.receipt);
    if (response.status === APPLE_STATUS_SANDBOX_RECEIPT) {
      response = await this.callApple(APPLE_SANDBOX_URL, input.receipt);
    } else if (response.status === APPLE_STATUS_PROD_RECEIPT) {
      // Belt-and-braces: a production receipt sent to sandbox → retry production.
      response = await this.callApple(APPLE_PROD_URL, input.receipt);
    }

    const valid = response.status === APPLE_STATUS_VALID;
    const entry = this.pickAppleEntry(response, input.productId);
    return {
      valid,
      transactionId:
        entry?.transaction_id ?? entry?.original_transaction_id ?? '',
      productId: entry?.product_id ?? input.productId,
    };
  }

  private async callApple(url: string, receipt: string): Promise<AppleVerifyResponse> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        'receipt-data': receipt,
        password: this.appleSharedSecret,
        'exclude-old-transactions': true,
      }),
    });
    if (!res.ok) {
      throw new Error(`Apple verifyReceipt HTTP ${res.status} from ${url}`);
    }
    return (await res.json()) as AppleVerifyResponse;
  }

  /** Prefer latest_receipt_info (subscriptions); prefer the entry matching productId, else last. */
  private pickAppleEntry(
    response: AppleVerifyResponse,
    productId: string,
  ): AppleInAppEntry | undefined {
    const entries = response.latest_receipt_info ?? response.receipt?.in_app ?? [];
    if (entries.length === 0) return undefined;
    return (
      entries.find((e) => e.product_id === productId) ?? entries[entries.length - 1]
    );
  }

  // ── Google ─────────────────────────────────────────────────────────────────
  private async verifyGoogle(input: VerifyReceiptInput): Promise<VerifyReceiptResult> {
    const accessToken = await this.mintGoogleAccessToken();

    const url =
      `${GOOGLE_ANDROIDPUBLISHER_BASE}/applications/` +
      `${encodeURIComponent(this.googlePackageName)}/purchases/subscriptions/` +
      `${encodeURIComponent(input.productId)}/tokens/${encodeURIComponent(input.receipt)}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(
        `Google Play purchases.subscriptions HTTP ${res.status} for ${input.productId}`,
      );
    }
    const purchase = (await res.json()) as GoogleSubscriptionPurchase;

    const valid =
      purchase.paymentState === GOOGLE_PAYMENT_STATE_RECEIVED ||
      purchase.paymentState === GOOGLE_PAYMENT_STATE_FREE_TRIAL;
    return {
      valid,
      transactionId: purchase.orderId ?? '',
      productId: input.productId,
    };
  }

  private async mintGoogleAccessToken(): Promise<string> {
    const sa = this.parseServiceAccount();
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64Url(
      JSON.stringify({
        iss: sa.client_email,
        scope: GOOGLE_SCOPE,
        aud: GOOGLE_TOKEN_URL,
        iat: now,
        exp: now + 3600, // max 1 hour per Google docs
      }),
    );
    const signingInput = `${header}.${claims}`;
    const signature = createSign('RSA-SHA256')
      .update(signingInput)
      .sign(sa.private_key);
    const assertion = `${signingInput}.${base64Url(signature)}`;

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: GOOGLE_JWT_BEARER_GRANT,
        assertion,
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`Google OAuth2 token HTTP ${res.status}`);
    }
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) {
      throw new Error('Google OAuth2 token response missing access_token');
    }
    return body.access_token;
  }

  private parseServiceAccount(): GoogleServiceAccount {
    let parsed: GoogleServiceAccount;
    try {
      parsed = JSON.parse(this.googleServiceAccountJson) as GoogleServiceAccount;
    } catch {
      throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON');
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error(
        'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON missing client_email or private_key',
      );
    }
    return parsed;
  }
}
