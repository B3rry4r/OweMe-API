import { OtpSender } from '../otp-sender';

/**
 * Real BulkSMS Nigeria OTP delivery, implementing the FROZEN OtpSender interface.
 *
 * Docs relied on (verified 2026-07):
 *  - API reference:      https://www.bulksmsnigeria.com/api/docs
 *  - API landing:        https://www.bulksmsnigeria.com/api
 *  - SMS API feature:    https://www.bulksmsnigeria.com/features/sms-api
 *  - Integration guide:  https://www.bulksmsnigeria.com/resources/api-integration-tutorial
 *
 * Verified contract (v2 — the recommended endpoint):
 *  - Endpoint:  POST https://www.bulksmsnigeria.com/api/v2/sms
 *  - Auth:      `api_token`. The docs list four accepted forms (Authorization: Bearer,
 *               `api_token:` header, `?api_token=` query, or body field). We use the
 *               recommended `Authorization: Bearer <api_token>` header.
 *  - Body (JSON): { from: <senderId, max 11 chars>, to: <comma-separated msisdns>,
 *                   body: <message text>, gateway: 'otp' }
 *               We set gateway='otp' — the docs expose an `otp` gateway option on the
 *               SMS endpoint (BulkSMS Nigeria has NO separate verify/OTP product), which
 *               routes one-time-code traffic over the OTP-optimised route.
 *  - Success:   HTTP 2xx, JSON { status: 'success', code: 'BSNG-0000',
 *               data: { message_id, ... } }
 *  - Error:     JSON { status: 'error', message, error_code?, ... } (or non-2xx HTTP).
 *  - Phone fmt: international, digits only, no '+', e.g. 2348012345678. Nigerian local
 *               numbers (0801...) are normalised to 234801... .
 */

const BULKSMS_SEND_URL = 'https://www.bulksmsnigeria.com/api/v2/sms';

/**
 * Normalise a Nigerian phone number to BulkSMS Nigeria's required MSISDN format:
 * digits only, international, e.g. "2348012345678".
 *  - strips spaces, dashes, parentheses and a leading '+'
 *  - a leading '0' (local format, e.g. 08012345678) becomes '234...'
 *  - a bare 10-digit subscriber number (8012345678) is prefixed with 234
 */
export function normalizeNigerianMsisdn(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.startsWith('234')) return digits;
  if (digits.startsWith('0')) return `234${digits.slice(1)}`;
  if (digits.length === 10) return `234${digits}`;
  return digits;
}

export class BulkSmsOtpSender implements OtpSender {
  constructor(
    private readonly apiToken: string,
    private readonly senderId: string,
  ) {}

  async sendOtp(phone: string, code: string): Promise<void> {
    const body = `Your OweMe code is ${code}`;

    const res = await fetch(BULKSMS_SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        from: this.senderId,
        to: normalizeNigerianMsisdn(phone),
        body,
        gateway: 'otp',
      }),
    });

    // Parse defensively — provider always replies JSON, but guard against gateway HTML.
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }

    const data = (payload ?? {}) as {
      status?: string;
      message?: string;
      error_code?: string;
      data?: { message_id?: string; sms_id?: string };
    };

    const ok = res.ok && data.status !== 'error';
    if (!ok) {
      const reason =
        data.message ?? data.error_code ?? `HTTP ${res.status} ${res.statusText}`;
      throw new Error(`BulkSMS Nigeria OTP send failed: ${reason}`);
    }
  }
}
