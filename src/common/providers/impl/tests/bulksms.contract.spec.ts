import { BulkSmsOtpSender } from '../bulksms-otp-sender';
import { BulkSmsMessageSender } from '../bulksms-message-sender';

/**
 * Contract tests for the real BulkSMS Nigeria integrations.
 * All network I/O is mocked via jest.spyOn(global, 'fetch') — NO real calls.
 *
 * Asserts against the verified v2 contract:
 *   POST https://www.bulksmsnigeria.com/api/v2/sms
 *   Authorization: Bearer <api_token>
 *   body { from, to, body[, gateway] }
 *   success { status: 'success', data: { message_id } } / error { status: 'error', message }
 */

const SEND_URL = 'https://www.bulksmsnigeria.com/api/v2/sms';
const API_TOKEN = 'test-token-123';
const SENDER_ID = 'OweMe';

function mockFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const status = init.status ?? (init.ok === false ? 400 : 200);
  const ok = init.ok ?? status < 400;
  return jest.spyOn(global, 'fetch').mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Bad Request',
    json: async () => body,
  } as unknown as Response);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('BulkSmsOtpSender', () => {
  it('POSTs to the verified URL with Bearer auth and the OTP gateway params', async () => {
    const spy = mockFetch({
      status: 'success',
      code: 'BSNG-0000',
      data: { message_id: 'msg-1' },
    });

    const sender = new BulkSmsOtpSender(API_TOKEN, SENDER_ID);
    await sender.sendOtp('08012345678', '482913');

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, opts] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(SEND_URL);
    expect(opts.method).toBe('POST');
    expect((opts.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${API_TOKEN}`,
    );

    const payload = JSON.parse(opts.body as string);
    expect(payload.from).toBe(SENDER_ID);
    expect(payload.to).toBe('2348012345678'); // local 0801... normalised to 234...
    expect(payload.gateway).toBe('otp');
    expect(payload.body).toContain('482913');
  });

  it('resolves without throwing on a success response', async () => {
    mockFetch({ status: 'success', data: { message_id: 'msg-2' } });
    const sender = new BulkSmsOtpSender(API_TOKEN, SENDER_ID);
    await expect(sender.sendOtp('2348012345678', '000000')).resolves.toBeUndefined();
  });

  it('throws with the provider reason on an error response', async () => {
    mockFetch(
      {
        status: 'error',
        message: 'Insufficient credits.',
        error_code: 'INSUFFICIENT_CREDITS',
      },
      { ok: false, status: 402 },
    );
    const sender = new BulkSmsOtpSender(API_TOKEN, SENDER_ID);
    await expect(sender.sendOtp('2348012345678', '111111')).rejects.toThrow(
      /Insufficient credits/,
    );
  });

  it('throws on a non-2xx HTTP status even without an error body', async () => {
    mockFetch({}, { ok: false, status: 500 });
    const sender = new BulkSmsOtpSender(API_TOKEN, SENDER_ID);
    await expect(sender.sendOtp('2348012345678', '222222')).rejects.toThrow(
      /BulkSMS Nigeria OTP send failed/,
    );
  });
});

describe('BulkSmsMessageSender', () => {
  it('POSTs to the verified URL and maps success to { providerMessageId, accepted }', async () => {
    const spy = mockFetch({
      status: 'success',
      data: { message_id: 'abc-123' },
    });

    const sender = new BulkSmsMessageSender(API_TOKEN, SENDER_ID);
    const result = await sender.send({
      phone: '08087654321',
      message: 'Reminder: you owe 5000',
      channel: 'sms',
    });

    const [url, opts] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(SEND_URL);
    expect((opts.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${API_TOKEN}`,
    );
    const payload = JSON.parse(opts.body as string);
    expect(payload.from).toBe(SENDER_ID);
    expect(payload.to).toBe('2348087654321');
    expect(payload.body).toBe('Reminder: you owe 5000');

    expect(result).toEqual({ providerMessageId: 'abc-123', accepted: true });
  });

  it('falls back to the SMS endpoint for channel:whatsapp and still returns a result', async () => {
    const spy = mockFetch({ status: 'success', data: { message_id: 'wa-1' } });

    const sender = new BulkSmsMessageSender(API_TOKEN, SENDER_ID);
    const result = await sender.send({
      phone: '2348012345678',
      message: 'hi',
      channel: 'whatsapp',
    });

    const [url] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(SEND_URL); // same SMS endpoint — no WhatsApp API exists
    expect(result).toEqual({ providerMessageId: 'wa-1', accepted: true });
  });

  it('returns accepted:false on a provider error response', async () => {
    mockFetch(
      { status: 'error', message: 'Invalid sender ID' },
      { ok: false, status: 422 },
    );
    const sender = new BulkSmsMessageSender(API_TOKEN, SENDER_ID);
    const result = await sender.send({
      phone: '2348012345678',
      message: 'hi',
      channel: 'sms',
    });
    expect(result.accepted).toBe(false);
    expect(result.providerMessageId).toBe('');
  });
});
