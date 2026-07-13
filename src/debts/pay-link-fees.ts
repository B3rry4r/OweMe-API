/**
 * Pay-link processing fees — MODEL REV 2 (FRONTEND-HANDOFF.md §4). All values kobo.
 *
 * Two DISTINCT figures, deliberately kept separate:
 *   - OweMe's actual commission (1% capped ₦500) is taken via the Paystack subaccount
 *     transaction split — passed to the gateway as `transactionCharge`.
 *   - The trader-facing DISCLOSED fee is the ONE combined figure only: 2.5% + ₦100,
 *     capped ₦2,500. The response NEVER exposes the Paystack-vs-OweMe breakdown.
 */

const NAIRA = 100; // 1 naira = 100 kobo

/** OweMe's commission for this payment: 1% of the amount, capped ₦500. */
export function owemeCommissionKobo(amountKobo: number): number {
  return Math.min(Math.round(amountKobo * 0.01), 500 * NAIRA);
}

/** The single combined processing fee disclosed to the trader: 2.5% + ₦100, capped ₦2,500. */
export function combinedPayLinkFeeKobo(amountKobo: number): number {
  return Math.min(Math.round(amountKobo * 0.025) + 100 * NAIRA, 2_500 * NAIRA);
}
