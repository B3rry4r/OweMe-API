/**
 * Monthly grant period boundaries. A "period" is one calendar month (UTC): grants refill
 * to the plan's monthlyGrant at the start of each new month. Resets are applied LAZILY on
 * read/debit — there is no scheduler (conventions §Metering: monthly grants per plan).
 */

/** Start (UTC midnight, day 1) of the calendar month containing `now`. */
export function currentPeriodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** True when `periodStart` predates the current period (i.e. a refill is due). */
export function isStalePeriod(periodStart: Date, now: Date = new Date()): boolean {
  return periodStart.getTime() < currentPeriodStart(now).getTime();
}

/**
 * Consumed units this period, for the GET /usage meters.
 * Fair-use (grant -1) is unmetered -> always 0. Bundle top-ups can push remaining above the
 * grant, so clamp at 0.
 */
export function usedFrom(monthlyGrant: number, remaining: number): number {
  if (monthlyGrant < 0) return 0;
  return Math.max(0, monthlyGrant - remaining);
}
