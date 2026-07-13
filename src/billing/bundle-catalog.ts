import { BillingKind } from '../shared';
import { nairaToKobo } from '../common';

/**
 * IAP consumable-bundle catalog — MODEL REV 2 (FRONTEND-HANDOFF.md §4).
 * ONE unified "OweMe credits" bundle line replaces the old message/AI bundles.
 * Non-plan productIds route here; plan products resolve from the seeded Plan table.
 *
 * HARD CAP: max 2 bundle purchases per business per calendar month (enforced in
 * BillingService/WebhooksService, not here). Prices are the store price in kobo (S-1).
 */
export interface BundleSpec {
  /** Unified OweMe credits granted. */
  quantity: number;
  /** Store price in kobo (recorded on the BillingTransaction). */
  amountKobo: number;
  /** Human label for the BillingTransaction. */
  label: string;
  /** BillingTransaction.kind. */
  kind: BillingKind;
}

/** productId -> bundle spec. All bundles credit the unified OweMe-credits ledger. */
export const BUNDLE_CATALOG: Record<string, BundleSpec> = {
  oweme_credits_250: {
    quantity: 250,
    amountKobo: nairaToKobo(2_000),
    label: '250 OweMe credits',
    kind: 'credits-bundle',
  },
  oweme_credits_600: {
    quantity: 600,
    amountKobo: nairaToKobo(4_000),
    label: '600 OweMe credits',
    kind: 'credits-bundle',
  },
  oweme_credits_1500: {
    quantity: 1_500,
    amountKobo: nairaToKobo(8_000),
    label: '1,500 OweMe credits',
    kind: 'credits-bundle',
  },
};

/** Max consumable-bundle purchases per business per calendar month (rev 2 hard cap). */
export const MONTHLY_BUNDLE_CAP = 2;

/** Resolve a bundle spec for a productId (undefined if it is not a known bundle). */
export function resolveBundle(productId: string): BundleSpec | undefined {
  return BUNDLE_CATALOG[productId];
}
