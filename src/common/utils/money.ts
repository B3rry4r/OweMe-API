/** Money utils. Canonical unit is integer kobo (S-1); naira = kobo / 100. Never floats in storage/wire. */

export const KOBO_PER_NAIRA = 100;

/** Whole naira -> kobo. */
export function nairaToKobo(naira: number): number {
  return Math.round(naira * KOBO_PER_NAIRA);
}

/** Kobo -> naira (display only). */
export function koboToNaira(kobo: number): number {
  return kobo / KOBO_PER_NAIRA;
}

/** Clamp to a non-negative integer amount of kobo (e.g. remaining = clamp(amount - paid)). */
export function clampKobo(kobo: number): number {
  return Math.max(0, Math.trunc(kobo));
}
