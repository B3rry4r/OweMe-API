import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

/**
 * Admin credential hashing helpers, mirroring the codebase crypto idiom
 * (src/auth/auth.crypto.ts): bcrypt/argon are not in the dependency set, so passwords
 * use Node's native salted scrypt and the high-entropy refresh JWT uses deterministic
 * SHA-256 for hashed-at-rest lookup. Deliberately DUPLICATED here rather than imported
 * from the user-auth tree: admin code paths never import user auth files.
 */

/** Salted scrypt hash of an admin password. Returns `salt:derivedHex`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${derived}`;
}

/** Constant-time verify of a password against a stored `salt:derivedHex`. */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const derived = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

/** Deterministic SHA-256 of a high-entropy token (admin refresh JWT) for lookup by hash. */
export function hashAdminToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Random temporary password for admin-create (returned ONCE in the create response,
 * never retrievable again). 12 base64url chars ~ 72 bits of entropy, and always over
 * the change-password minimum length.
 */
export function generateTempPassword(): string {
  return randomBytes(9).toString('base64url');
}
