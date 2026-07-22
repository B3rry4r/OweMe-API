/**
 * Canonical phone identity for the whole API.
 *
 * A phone number IS the account identifier (signup, OTP, staff lookup), so the
 * SAME human number must always produce the SAME string — otherwise one person
 * signing in as `08031472093` and `+2348031472093` becomes two accounts, and an
 * OTP issued against one form can never be verified against the other.
 *
 * Canonical form is E.164: `+234` followed by the 10-digit subscriber number.
 *   08031472093     -> +2348031472093   (local, leading 0)
 *   2348031472093   -> +2348031472093   (international, no plus)
 *   +234 803 147 2093 -> +2348031472093 (spaces/dashes/parens stripped)
 *   8031472093      -> +2348031472093   (bare subscriber number)
 *
 * Anything that does not look like a Nigerian number is returned trimmed but
 * otherwise untouched: this normaliser must never silently mangle a number it
 * does not understand into a wrong-but-plausible one.
 *
 * NOTE: this is identity normalisation. `normalizeNigerianMsisdn` in the BulkSMS
 * providers is a separate, provider-specific wire format (digits only, no '+').
 */
export function normalizePhone(phone: string): string {
  const trimmed = (phone ?? '').trim();
  const digits = trimmed.replace(/[^\d]/g, '');

  // 234XXXXXXXXXX — international form, with or without a leading '+'.
  if (digits.startsWith('234') && digits.length === 13) return `+${digits}`;
  // 0XXXXXXXXXX — local form.
  if (digits.startsWith('0') && digits.length === 11) return `+234${digits.slice(1)}`;
  // XXXXXXXXXX — bare subscriber number.
  if (digits.length === 10) return `+234${digits}`;

  return trimmed;
}

/**
 * Every stored form that should be treated as THIS number when reading.
 *
 * New rows are always written canonical, but rows created before canonicalisation
 * (and fixtures/imports) may hold the local or plus-less international form. Reads
 * therefore match on the whole variant set, so no existing account is orphaned by
 * the switch, while writes converge on E.164. Deduplicated and never empty.
 */
export function phoneVariants(phone: string): string[] {
  const trimmed = (phone ?? '').trim();
  const canonical = normalizePhone(trimmed);
  const digits = trimmed.replace(/[^\d]/g, '');

  const variants = new Set<string>([trimmed, canonical]);
  if (canonical.startsWith('+234')) {
    const subscriber = canonical.slice(4); // 10-digit national number
    variants.add(`234${subscriber}`); // international, no '+'
    variants.add(`0${subscriber}`); // local
  }
  if (digits) variants.add(digits);
  variants.delete('');
  return variants.size > 0 ? [...variants] : [trimmed];
}
