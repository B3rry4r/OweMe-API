import { createHmac } from 'node:crypto';
import { PaystackGatewayHttp } from '../paystack-gateway.http';

/**
 * Contract tests for the real Paystack HTTP gateway. Global `fetch` is mocked — NO network.
 * Each test asserts the outgoing request (URL, method, auth header, body) and that the
 * `{status, message, data}` envelope is parsed into the frozen result shape.
 */

const SECRET = 'sk_test_deadbeef';
const BASE = 'https://api.paystack.co';

type FetchMock = jest.Mock<Promise<Response>, Parameters<typeof fetch>>;

function okEnvelope(data: unknown, init?: { status?: number }): Response {
  return {
    ok: (init?.status ?? 200) >= 200 && (init?.status ?? 200) < 300,
    status: init?.status ?? 200,
    statusText: 'OK',
    json: async () => ({ status: true, message: 'Success', data }),
  } as unknown as Response;
}

function failEnvelope(message: string, httpStatus = 200): Response {
  return {
    ok: httpStatus >= 200 && httpStatus < 300,
    status: httpStatus,
    statusText: 'Error',
    json: async () => ({ status: false, message }),
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

describe('PaystackGatewayHttp — listBanks', () => {
  it('GETs /bank with country/currency and maps to {code,name}', async () => {
    fetchMock.mockResolvedValueOnce(
      okEnvelope([
        { name: 'Access Bank', slug: 'access-bank', code: '044' },
        { name: 'Zenith Bank', slug: 'zenith-bank', code: '057' },
      ]),
    );
    const gw = new PaystackGatewayHttp(SECRET);
    const banks = await gw.listBanks();

    const { url, opts } = lastCall();
    expect(url).toBe(`${BASE}/bank?country=nigeria&currency=NGN`);
    expect(opts.method).toBe('GET');
    expect((opts.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
    expect(banks).toEqual([
      { code: '044', name: 'Access Bank' },
      { code: '057', name: 'Zenith Bank' },
    ]);
  });
});

describe('PaystackGatewayHttp — resolveAccount', () => {
  it('GETs /bank/resolve with query params and returns accountName', async () => {
    fetchMock.mockResolvedValueOnce(
      okEnvelope({ account_number: '0022728151', account_name: 'JANE DOE', bank_id: 9 }),
    );
    const gw = new PaystackGatewayHttp(SECRET);
    const result = await gw.resolveAccount('063', '0022728151');

    const { url, opts } = lastCall();
    expect(url).toBe(`${BASE}/bank/resolve?account_number=0022728151&bank_code=063`);
    expect(opts.method).toBe('GET');
    expect((opts.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
    expect(result).toEqual({ accountName: 'JANE DOE' });
  });
});

describe('PaystackGatewayHttp — createSubaccount', () => {
  it('POSTs /subaccount with the required body and returns subaccountCode', async () => {
    fetchMock.mockResolvedValueOnce(
      okEnvelope({ subaccount_code: 'ACCT_xyz123', id: 55 }, { status: 201 }),
    );
    const gw = new PaystackGatewayHttp(SECRET);
    const result = await gw.createSubaccount({
      businessName: 'Oasis',
      bankCode: '058',
      accountNumber: '0123456047',
    });

    const { url, opts } = lastCall();
    expect(url).toBe(`${BASE}/subaccount`);
    expect(opts.method).toBe('POST');
    expect((opts.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
    expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body as string)).toEqual({
      business_name: 'Oasis',
      settlement_bank: '058',
      account_number: '0123456047',
      percentage_charge: 100,
    });
    expect(result).toEqual({ subaccountCode: 'ACCT_xyz123' });
  });
});

describe('PaystackGatewayHttp — createPaymentRequest', () => {
  it('POSTs /transaction/initialize with amount(kobo), reference, subaccount and placeholder email', async () => {
    fetchMock.mockResolvedValueOnce(
      okEnvelope({
        authorization_url: 'https://checkout.paystack.com/abc123',
        access_code: 'abc123',
        reference: 'ref_001',
      }),
    );
    const gw = new PaystackGatewayHttp(SECRET);
    const result = await gw.createPaymentRequest({
      amount: 500000,
      reference: 'ref_001',
      subaccountCode: 'ACCT_xyz123',
    });

    const { url, opts } = lastCall();
    expect(url).toBe(`${BASE}/transaction/initialize`);
    expect(opts.method).toBe('POST');
    expect((opts.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
    const body = JSON.parse(opts.body as string);
    expect(body.amount).toBe(500000);
    expect(body.reference).toBe('ref_001');
    expect(body.subaccount).toBe('ACCT_xyz123');
    expect(body.email).toBe('payments+ref_001@oweme.app');
    expect(result).toEqual({
      url: 'https://checkout.paystack.com/abc123',
      reference: 'ref_001',
    });
  });

  it('uses metadata.email when supplied and omits subaccount when null', async () => {
    fetchMock.mockResolvedValueOnce(
      okEnvelope({
        authorization_url: 'https://checkout.paystack.com/def',
        access_code: 'def',
        reference: 'ref_002',
      }),
    );
    const gw = new PaystackGatewayHttp(SECRET);
    await gw.createPaymentRequest({
      amount: 1000,
      reference: 'ref_002',
      subaccountCode: null,
      metadata: { email: 'real@user.com', debtId: 'd1' },
    });

    const body = JSON.parse(lastCall().opts.body as string);
    expect(body.email).toBe('real@user.com');
    expect(body.metadata).toEqual({ email: 'real@user.com', debtId: 'd1' });
    expect('subaccount' in body).toBe(false);
  });
});

describe('PaystackGatewayHttp — error paths', () => {
  it('throws when the envelope status is false', async () => {
    fetchMock.mockResolvedValueOnce(failEnvelope('Invalid bank code'));
    const gw = new PaystackGatewayHttp(SECRET);
    await expect(gw.resolveAccount('000', '1')).rejects.toThrow(/status=false: Invalid bank code/);
  });

  it('throws on non-2xx HTTP', async () => {
    fetchMock.mockResolvedValueOnce(failEnvelope('Unauthorized', 401));
    const gw = new PaystackGatewayHttp(SECRET);
    await expect(gw.listBanks()).rejects.toThrow(/HTTP 401.*Unauthorized/);
  });
});

describe('PaystackGatewayHttp — verifySignature', () => {
  it('returns true for a correct HMAC-SHA512 hex signature', () => {
    const gw = new PaystackGatewayHttp(SECRET);
    const rawBody = JSON.stringify({ event: 'charge.success', data: { reference: 'ref_001' } });
    const expected = createHmac('sha512', SECRET).update(rawBody).digest('hex');
    expect(gw.verifySignature(rawBody, expected)).toBe(true);
  });

  it('returns true for a Buffer body', () => {
    const gw = new PaystackGatewayHttp(SECRET);
    const rawBody = Buffer.from('{"event":"charge.success"}', 'utf8');
    const expected = createHmac('sha512', SECRET).update(rawBody).digest('hex');
    expect(gw.verifySignature(rawBody, expected)).toBe(true);
  });

  it('returns false for a wrong signature', () => {
    const gw = new PaystackGatewayHttp(SECRET);
    const rawBody = '{"event":"charge.success"}';
    const wrong = createHmac('sha512', 'sk_test_other').update(rawBody).digest('hex');
    expect(gw.verifySignature(rawBody, wrong)).toBe(false);
  });

  it('returns false (never throws) for empty/garbage signatures', () => {
    const gw = new PaystackGatewayHttp(SECRET);
    expect(gw.verifySignature('body', '')).toBe(false);
    expect(gw.verifySignature('body', 'not-a-hash')).toBe(false);
  });
});
