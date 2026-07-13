import { VersionConflictException } from '../exceptions/app.exception';

/**
 * Optimistic-concurrency helpers for the offline-first sync protocol.
 * Writes carry `If-Match: version=N`; a stale write -> 409 { error, current } (LWW per field-set).
 */

/** Parse the `If-Match: version=N` header. Returns the int, or null when absent/malformed. */
export function parseIfMatchVersion(header: string | string[] | undefined): number | null {
  if (!header) return null;
  const raw = Array.isArray(header) ? header[0] : header;
  const m = /version\s*=\s*"?(\d+)"?/i.exec(raw);
  if (m) return Number(m[1]);
  // also accept a bare integer If-Match value
  if (/^\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

/**
 * Assert the client's expected version matches the current server row. On mismatch,
 * throws VersionConflictException carrying the current row so the client can re-apply.
 * When `expected` is null (no If-Match sent) this is a no-op (last-writer-wins).
 */
export function assertVersion(
  expected: number | null,
  current: { version: number } & Record<string, unknown>,
): void {
  if (expected === null) return;
  if (expected !== current.version) {
    throw new VersionConflictException(current);
  }
}
