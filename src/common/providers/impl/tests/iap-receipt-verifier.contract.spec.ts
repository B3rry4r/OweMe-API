/**
 * Contract tests for the REAL IapReceiptVerifier (Apple + Google).
 * All network is mocked via global `fetch` — NO real network calls.
 *
 * Apple docs:  https://developer.apple.com/documentation/appstorereceipts/verifyreceipt
 * Google docs: https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptions
 */
import { generateKeyPairSync } from 'node:crypto';
import { IapReceiptVerifier } from '../iap-receipt-verifier';

const APPLE_PROD_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_SANDBOX_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// A syntactically valid throwaway RSA key so crypto.sign works without a real Google key.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'test-sa@oweme.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
});
const PACKAGE_NAME = 'com.oweme.app';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

function makeVerifier(): IapReceiptVerifier {
  return new IapReceiptVerifier('apple-shared-secret', SERVICE_ACCOUNT_JSON, PACKAGE_NAME);
}

describe('IapReceiptVerifier (contract)', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Apple ──────────────────────────────────────────────────────────────────
  describe('Apple (ios)', () => {
    it('returns valid with parsed transaction/product for status 0', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          status: 0,
          latest_receipt_info: [
            {
              transaction_id: '1000000123456789',
              original_transaction_id: '1000000000000001',
              product_id: 'com.oweme.sub.market',
            },
          ],
        }),
      );

      const result = await makeVerifier().verify({
        platform: 'ios',
        productId: 'com.oweme.sub.market',
        receipt: 'BASE64RECEIPT',
      });

      expect(result).toEqual({
        valid: true,
        transactionId: '1000000123456789',
        productId: 'com.oweme.sub.market',
      });
      // Production endpoint hit, with correct body.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(APPLE_PROD_URL);
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body).toEqual({
        'receipt-data': 'BASE64RECEIPT',
        password: 'apple-shared-secret',
        'exclude-old-transactions': true,
      });
    });

    it('retries against the sandbox endpoint on status 21007, then succeeds', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ status: 21007 }))
        .mockResolvedValueOnce(
          jsonResponse({
            status: 0,
            latest_receipt_info: [
              { transaction_id: 'SANDBOX_TXN_1', product_id: 'com.oweme.sub.market' },
            ],
          }),
        );

      const result = await makeVerifier().verify({
        platform: 'ios',
        productId: 'com.oweme.sub.market',
        receipt: 'SANDBOXRECEIPT',
      });

      expect(result.valid).toBe(true);
      expect(result.transactionId).toBe('SANDBOX_TXN_1');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe(APPLE_PROD_URL);
      expect(fetchMock.mock.calls[1][0]).toBe(APPLE_SANDBOX_URL);
    });

    it('returns valid:false for a non-zero status', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ status: 21010 }));

      const result = await makeVerifier().verify({
        platform: 'ios',
        productId: 'com.oweme.sub.market',
        receipt: 'BADRECEIPT',
      });

      expect(result.valid).toBe(false);
      expect(result.productId).toBe('com.oweme.sub.market');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // ── Google ─────────────────────────────────────────────────────────────────
  describe('Google (android)', () => {
    it('mints an OAuth token then applies the Bearer to a valid subscription purchase', async () => {
      fetchMock
        // 1) OAuth token POST
        .mockResolvedValueOnce(jsonResponse({ access_token: 'ya29.ACCESS_TOKEN', expires_in: 3599 }))
        // 2) purchases.subscriptions GET
        .mockResolvedValueOnce(
          jsonResponse({
            paymentState: 1,
            orderId: 'GPA.1234-5678-9012-34567',
            expiryTimeMillis: '9999999999999',
          }),
        );

      const result = await makeVerifier().verify({
        platform: 'android',
        productId: 'com.oweme.sub.market',
        receipt: 'PURCHASE_TOKEN_ABC',
      });

      expect(result).toEqual({
        valid: true,
        transactionId: 'GPA.1234-5678-9012-34567',
        productId: 'com.oweme.sub.market',
      });

      // First call: OAuth token endpoint with jwt-bearer grant.
      const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
      expect(tokenUrl).toBe(GOOGLE_TOKEN_URL);
      expect((tokenInit as RequestInit).body as string).toContain(
        'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer',
      );
      expect((tokenInit as RequestInit).body as string).toContain('assertion=');

      // Second call: androidpublisher GET with Authorization: Bearer.
      const [purchaseUrl, purchaseInit] = fetchMock.mock.calls[1];
      expect(purchaseUrl).toContain(
        'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.oweme.app/purchases/subscriptions/com.oweme.sub.market/tokens/PURCHASE_TOKEN_ABC',
      );
      expect((purchaseInit as RequestInit).headers).toEqual({
        Authorization: 'Bearer ya29.ACCESS_TOKEN',
      });
    });

    it('returns valid:false for a pending (paymentState 0) purchase', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: 'ya29.ACCESS_TOKEN' }))
        .mockResolvedValueOnce(jsonResponse({ paymentState: 0, orderId: 'GPA.PENDING' }));

      const result = await makeVerifier().verify({
        platform: 'android',
        productId: 'com.oweme.sub.market',
        receipt: 'PURCHASE_TOKEN_PENDING',
      });

      expect(result.valid).toBe(false);
      expect(result.transactionId).toBe('GPA.PENDING');
    });
  });
});
