import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

/**
 * Auth hashing helpers. bcrypt/argon are not in the dependency set, so we use Node's
 * native scrypt (salted, for the low-entropy OTP) and SHA-256 (deterministic, for the
 * high-entropy refresh-token JWT so it can be looked up by hash).
 */

/** Salted scrypt hash of a low-entropy secret (OTP code). Returns `salt:derivedHex`. */
export function hashOtpCode(code: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(code, salt, 32).toString('hex');
  return `${salt}:${derived}`;
}

/** Constant-time verify of an OTP code against a stored `salt:derivedHex`. */
export function verifyOtpCode(code: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const derived = scryptSync(code, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

/** Deterministic SHA-256 of a high-entropy token (refresh JWT) for hashed-at-rest lookup. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Cryptographically-random 6-digit numeric OTP (no leading-zero ambiguity). */
export function generateOtp(): string {
  const n = (randomBytes(4).readUInt32BE(0) % 900000) + 100000;
  return String(n);
}
