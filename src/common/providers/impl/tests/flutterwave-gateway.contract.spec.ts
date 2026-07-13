import { FlutterwaveGateway } from '../flutterwave-gateway';

/**
 * Contract tests for the real Flutterwave v3 gateway. Global `fetch` is mocked — NO network.
 * Each test asserts the outgoing request (URL, method, auth header, body — including the
 * kobo->naira conversion) and that the `{status, message, data}` envelope is parsed into the
 * frozen result shape. Also covers the error path and `verif-hash` signature verification.
 */

const SECRET = 'FLWSECK_TEST-deadbeef';
const HASH = 'my-configured-secret-hash';
const BASE = 'https://api.flutterwave.com/v3';

type FetchMock = jest.Mock<Promise<Response>, Parameters<typeof fetch>>;

function okEnvelope(data: unknown, init?: { status?: number }): Response {
  return {
    ok: (init?.status ?? 200) >= 200 && (init?.status ?? 200) < 300,
    status: init?.status ?? 200,
    statusText: 'OK',
    json: async () => ({ status: 'success', message: 'Success', data }),
  } as unknown as Response;
}

function failEnvelope(message: string, httpStatus = 200): Response {
  return {
    ok: httpStatus >= 200 && httpStatus < 300,
    status: httpStatus,
    statusText: 'Error',
    json: async () => ({ status: 'error', message }),
  } as unknown as Response;
}

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

function lastCall() {
  const [url, opts] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url: String(url), opts: opts as RequestInit };
}

function authOf(opts: RequestInit): string {
  return (opts.headers as Record<string, string>).Authorization;
}

describe('FlutterwaveGateway — listBanks', () => {
  it('GETs /banks/NG and maps to {code,name}', async () => {
    fetchMock.mockResolvedValueOnce(
      okEnvelope([
        { id: 132, code: '044', name: 'Access Bank' },
        { id: 145, code: '057', name: 'Zenith Bank' },
      ]),
    );
    const gw = new FlutterwaveGateway(SECRET, HASH);
    const banks = await gw.listBanks();

    const { url, opts } = lastCall();
    expect(url).toBe(`${BASE}/banks/NG`);
    expect(opts.method).toBe('GET');
    expect(authOf(opts)).toBe(`Bearer ${SECRET}`);
    expect(banks).toEqual([
      { code: '044', name: 'Access Bank' },
      { code: '057', name: 'Zenith Bank' },
    ]);
  });
});

describe('FlutterwaveGateway — resolveAccount', () => {
  it('POSTs /accounts/resolve with account_number/account_bank and returns accountName', async () => {
    fetchMock.mockResolvedValueOnce(
      okEnvelope({ account_number: '0690000032', account_name: 'JANE DOE' }),
    );
    const gw = new FlutterwaveGateway(SECRET, HASH);
    const result = await gw.resolveAccount('044', '0690000032');

    const { url, opts } = lastCall();
    expect(url).toBe(`${BASE}/accounts/resolve`);
    expect(opts.method).toBe('POST');
    expect(authOf(opts)).toBe(`Bearer ${SECRET}`);
    expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body as string)).toEqual({
      account_number: '0690000032',
      account_bank: '044',
    });
    expect(result).toEqual({ accountName: 'JANE DOE' });
  });
});

describe('FlutterwaveGateway — createSubaccount', () => {
  it('POSTs /subaccounts with the required body and returns subaccountCode', async () => {
    fetchMock.mockResolvedValueOnce(
      okEnvelope({
        id: 1234,
        subaccount_id: 'RS_24196D82F7AB6611C9D2E71E78215370',
        account_number: '0123456047',
        account_bank: '058',
        split_type: 'percentage',
        split_value: 1,
      }),
    );
    const gw = new FlutterwaveGateway(SECRET, HASH);
    const result = await gw.createSubaccount({
      businessName: 'Oasis',
      bankCode: '058',
      accountNumber: '0123456047',
    });

    const { url, opts } = lastCall();
    expect(url).toBe(`${BASE}/subaccounts`);
    expect(opts.method).toBe('POST');
    expect(authOf(opts)).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(opts.body as string)).toEqual({
      account_bank: '058',
      account_number: '0123456047',
      business_name: 'Oasis',
      country: 'NG',
      split_type: 'percentage',
      split_value: 1,
    });
    expect(result).toEqual({ subaccountCode: 'RS_24196D82F7AB6611C9D2E71E78215370' });
  });
});

describe('FlutterwaveGateway — createPaymentRequest', () => {
  it('POSTs /payments converting kobo->naira, sends subaccounts and derived customer/redirect', async () => {
    fetchMock.mockResolvedValueOnce(
      okEnvelope({
        link: 'https://checkout.flutterwave.com/v3/hosted/pay/flwlnk-abc123',
      }),
    );
    const gw = new FlutterwaveGateway(SECRET, HASH);
    const result = await gw.createPaymentRequest({
      amount: 500000, // kobo -> 5000 naira
      reference: 'ref_001',
      subaccountCode: 'RS_ABC',
    });

    const { url, opts } = lastCall();
    expect(url).toBe(`${BASE}/payments`);
    expect(opts.method).toBe('POST');
    expect(authOf(opts)).toBe(`Bearer ${SECRET}`);
    const body = JSON.parse(opts.body as string);
    expect(body.tx_ref).toBe('ref_001');
    expect(body.amount).toBe(5000); // kobo -> naira
    expect(body.currency).toBe('NGN');
    expect(body.customer).toEqual({ email: 'payments+ref_001@oweme.app' });
    expect(body.redirect_url).toContain('ref_001');
    expect(body.subaccounts).toEqual([{ id: 'RS_ABC' }]);
    expect(result).toEqual({
      url: 'https://checkout.flutterwave.com/v3/hosted/pay/flwlnk-abc123',
      reference: 'ref_001',
    });
  });

  it('uses metadata.email/redirect_url when supplied and omits subaccounts when null', async () => {
    fetchMock.mockResolvedValueOnce(
      okEnvelope({ link: 'https://checkout.flutterwave.com/v3/hosted/pay/flwlnk-def' }),
    );
    const gw = new FlutterwaveGateway(SECRET, HASH);
    await gw.createPaymentRequest({
      amount: 1000, // -> 10 naira
      reference: 'ref_002',
      subaccountCode: null,
      metadata: { email: 'real@user.com', redirect_url: 'https://app.test/done', debtId: 'd1' },
    });

    const body = JSON.parse(lastCall().opts.body as string);
    expect(body.amount).toBe(10);
    expect(body.customer).toEqual({ email: 'real@user.com' });
    expect(body.redirect_url).toBe('https://app.test/done');
    expect(body.meta).toEqual({ email: 'real@user.com', redirect_url: 'https://app.test/done', debtId: 'd1' });
    expect('subaccounts' in body).toBe(false);
  });
});

describe('FlutterwaveGateway — error paths', () => {
  it('throws when the envelope status is not success', async () => {
    fetchMock.mockResolvedValueOnce(failEnvelope('Invalid account'));
    const gw = new FlutterwaveGateway(SECRET, HASH);
    await expect(gw.resolveAccount('000', '1')).rejects.toThrow(
      /status!=success: Invalid account/,
    );
  });

  it('throws on non-2xx HTTP', async () => {
    fetchMock.mockResolvedValueOnce(failEnvelope('Unauthorized', 401));
    const gw = new FlutterwaveGateway(SECRET, HASH);
    await expect(gw.listBanks()).rejects.toThrow(/HTTP 401.*Unauthorized/);
  });
});

describe('FlutterwaveGateway — verifySignature (verif-hash)', () => {
  it('returns true when the verif-hash header equals the configured secret hash', () => {
    const gw = new FlutterwaveGateway(SECRET, HASH);
    // rawBody is unused for Flutterwave — pass anything.
    expect(gw.verifySignature('{"event":"charge.completed"}', HASH)).toBe(true);
  });

  it('returns true regardless of body type (Buffer)', () => {
    const gw = new FlutterwaveGateway(SECRET, HASH);
    expect(gw.verifySignature(Buffer.from('whatever'), HASH)).toBe(true);
  });

  it('returns false for a mismatched hash', () => {
    const gw = new FlutterwaveGateway(SECRET, HASH);
    expect(gw.verifySignature('body', 'wrong-hash')).toBe(false);
  });

  it('returns false (never throws) for empty/garbage signatures', () => {
    const gw = new FlutterwaveGateway(SECRET, HASH);
    expect(gw.verifySignature('body', '')).toBe(false);
    expect(gw.verifySignature('body', undefined as unknown as string)).toBe(false);
  });
});
