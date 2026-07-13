import {
  MessageSender,
  SendMessageInput,
  SendMessageResult,
} from '../message-sender';

/**
 * Real BulkSMS Nigeria message delivery, implementing the FROZEN MessageSender interface.
 *
 * Docs relied on (verified 2026-07):
 *  - API reference:      https://www.bulksmsnigeria.com/api/docs
 *  - API landing:        https://www.bulksmsnigeria.com/api
 *  - SMS API feature:    https://www.bulksmsnigeria.com/features/sms-api
 *  - Integration guide:  https://www.bulksmsnigeria.com/resources/api-integration-tutorial
 *
 * Verified contract (v2 — the recommended endpoint):
 *  - Endpoint:  POST https://www.bulksmsnigeria.com/api/v2/sms
 *  - Auth:      `Authorization: Bearer <api_token>` (recommended of the four accepted forms).
 *  - Body (JSON): { from: <senderId>, to: <comma-separated msisdns>, body: <message text> }
 *  - Success:   HTTP 2xx, JSON { status: 'success', data: { message_id, ... } }
 *  - Error:     JSON { status: 'error', message, ... } (or non-2xx HTTP).
 *  - Phone fmt: international digits, e.g. 2348012345678.
 *
 * WhatsApp decision:
 *  BulkSMS Nigeria's published API exposes NO WhatsApp channel — the SMS endpoint and its
 *  `gateway` options (direct-refund / direct-corporate / otp / dual-backup) are the only
 *  delivery routes documented; there is no WhatsApp / verify product. Because callers use
 *  this sender for reminder delivery (the message must still reach the recipient), we FALL
 *  BACK to SMS for channel:'whatsapp' rather than throwing, and still return a result. The
 *  request is identical; only the caller-supplied channel differs.
 */

const BULKSMS_SEND_URL = 'https://www.bulksmsnigeria.com/api/v2/sms';

/**
 * Normalise a Nigerian phone number to BulkSMS Nigeria's required MSISDN format:
 * digits only, international, e.g. "2348012345678".
 */
export function normalizeNigerianMsisdn(phone: string): string {
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.startsWith('234')) return digits;
  if (digits.startsWith('0')) return `234${digits.slice(1)}`;
  if (digits.length === 10) return `234${digits}`;
  return digits;
}

export class BulkSmsMessageSender implements MessageSender {
  constructor(
    private readonly apiToken: string,
    private readonly senderId: string,
  ) {}

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    // 'whatsapp' falls back to SMS (see WhatsApp decision above); the wire request is identical.
    const res = await fetch(BULKSMS_SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        from: this.senderId,
        to: normalizeNigerianMsisdn(input.phone),
        body: input.message,
      }),
    });

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

    const providerMessageId = data.data?.message_id ?? data.data?.sms_id ?? '';
    const accepted = res.ok && data.status !== 'error' && providerMessageId !== '';

    return { providerMessageId, accepted };
  }
}
