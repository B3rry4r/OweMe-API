import { randomBytes } from 'crypto';

/**
 * UUIDv7 (time-ordered) — ids are normally CLIENT-minted (S-2), but the server mints
 * them for server-originated rows (e.g. webhook-created payments, receipt numbers' backing rows).
 */
export function uuidv7(): string {
  const ts = Date.now();
  const rnd = randomBytes(10);

  const bytes = new Uint8Array(16);
  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = 0x70 | (rnd[0] & 0x0f); // version 7
  bytes[7] = rnd[1];
  bytes[8] = 0x80 | (rnd[2] & 0x3f); // variant
  bytes[9] = rnd[3];
  for (let i = 10; i < 16; i++) bytes[i] = rnd[i - 6];

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
