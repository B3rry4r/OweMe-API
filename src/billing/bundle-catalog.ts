import { BillingKind } from '../shared';
import { nairaToKobo } from '../common';

/**
 * IAP consumable-bundle catalog (conventions.md §Metering — owner-approved, final).
 * Non-plan productIds route here. Plan products (oweme_market_monthly / oweme_business_monthly)
 * are resolved dynamically from the seeded Plan table instead.
 *
 * Prices are the store price; stored to integer kobo (S-1). `kind` matches BillingTransaction.
 */
export interface BundleSpec {
  /** Which ledger the bundle credits. */
  ledger: 'send' | 'credit';
  /** Units credited to the ledger (sends or AI credits). */
  quantity: number;
  /** Store price in kobo (recorded on the BillingTransaction). */
  amountKobo: number;
  /** Human label for the BillingTransaction. */
  label: string;
  /** BillingTransaction.kind. */
  kind: BillingKind;
}

/** productId -> bundle spec. Message bundles credit the send allowance; AI bundles credit credits. */
export const BUNDLE_CATALOG: Record<string, BundleSpec> = {
  // Message bundles (one allowance across SMS & WhatsApp): 50/₦750 · 150/₦2,000 · 500/₦6,000
  oweme_sends_50: {
    ledger: 'send',
    quantity: 50,
    amountKobo: nairaToKobo(750),
    label: '50 message sends',
    kind: 'messages-bundle',
  },
  oweme_sends_150: {
    ledger: 'send',
    quantity: 150,
    amountKobo: nairaToKobo(2_000),
    label: '150 message sends',
    kind: 'messages-bundle',
  },
  oweme_sends_500: {
    ledger: 'send',
    quantity: 500,
    amountKobo: nairaToKobo(6_000),
    label: '500 message sends',
    kind: 'messages-bundle',
  },

  // AI-credit bundles: 50/₦500 · 150/₦1,200 · 400/₦2,800
  oweme_ai_credits_50: {
    ledger: 'credit',
    quantity: 50,
    amountKobo: nairaToKobo(500),
    label: '50 AI credits',
    kind: 'ai-bundle',
  },
  oweme_ai_credits_150: {
    ledger: 'credit',
    quantity: 150,
    amountKobo: nairaToKobo(1_200),
    label: '150 AI credits',
    kind: 'ai-bundle',
  },
  oweme_ai_credits_400: {
    ledger: 'credit',
    quantity: 400,
    amountKobo: nairaToKobo(2_800),
    label: '400 AI credits',
    kind: 'ai-bundle',
  },
};

/** Resolve a bundle spec for a productId (undefined if it is not a known bundle). */
export function resolveBundle(productId: string): BundleSpec | undefined {
  return BUNDLE_CATALOG[productId];
}
