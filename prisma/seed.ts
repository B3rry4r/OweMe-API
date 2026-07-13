/**
 * Plan catalog seed — MODEL REV 2 (FRONTEND-HANDOFF.md §4). Five canonical tiers.
 * Money is integer kobo (S-1). Idempotent: upsert by plan id, safe to re-run.
 *
 *   Unified OweMe credits/month: 50 / 300 / 1,200 / 3,000 / fair-use(-1).
 *   BVUM ceilings (kobo): ₦300k / ₦1.5M / ₦6M / ₦20M / ₦40M base (enterprise
 *   is BANDED via Business.bvumCeilingOverride — never unlimited/null).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NAIRA = 100; // 1 naira = 100 kobo
const M = 1_000_000;

type PlanSeed = {
  id: string;
  name: string;
  pricePerMonth: number; // kobo
  tagline: string;
  features: string[];
  productId: string | null;
  talkToSales: boolean;
  recommended: boolean;
  creditsPerMonth: number; // unified OweMe credits, -1 = fair-use
  staffSeats: number;
  bvumCeiling: number | null; // kobo
};

const PLANS: PlanSeed[] = [
  {
    id: 'starter',
    name: 'Starter',
    pricePerMonth: 0,
    tagline: 'Free — everything you need to start recovering debts.',
    features: [
      'Unlimited customers & debts',
      'Receipts, offline mode & basic dashboard',
      'Automated reminder scheduling',
      '50 OweMe credits / month',
      'Unlimited manual reminders · receipts',
    ],
    productId: null,
    talkToSales: false,
    recommended: false,
    creditsPerMonth: 50,
    staffSeats: 0,
    bvumCeiling: 300_000 * NAIRA, // ₦300k
  },
  {
    id: 'market',
    name: 'Market',
    pricePerMonth: 2_500 * NAIRA, // ₦2,500
    tagline: 'For growing market traders.',
    features: [
      'Everything in Starter',
      '300 credits / month · pay-links',
      '1 staff seat',
      'Business value up to ₦1.5M',
    ],
    productId: 'oweme_market_monthly',
    talkToSales: false,
    recommended: true,
    creditsPerMonth: 300,
    staffSeats: 1,
    bvumCeiling: 1.5 * M * NAIRA, // ₦1.5M
  },
  {
    id: 'business',
    name: 'Business',
    pricePerMonth: 6_000 * NAIRA, // ₦6,000
    tagline: 'For established businesses managing at scale.',
    features: [
      'Everything in Market',
      '1,200 credits / month',
      '5 staff seats',
      'Business value up to ₦6M',
    ],
    productId: 'oweme_business_monthly',
    talkToSales: false,
    recommended: false,
    creditsPerMonth: 1_200,
    staffSeats: 5,
    bvumCeiling: 6 * M * NAIRA, // ₦6M
  },
  {
    id: 'wholesale',
    name: 'Wholesale',
    pricePerMonth: 12_000 * NAIRA, // ₦12,000
    tagline: 'For distributors and wholesalers.',
    features: [
      'Everything in Business',
      '3,000 credits / month',
      '15 staff seats',
      'Business value up to ₦20M',
    ],
    productId: 'oweme_wholesale_monthly',
    talkToSales: false,
    recommended: false,
    creditsPerMonth: 3_000,
    staffSeats: 15,
    bvumCeiling: 20 * M * NAIRA, // ₦20M
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    pricePerMonth: 25_000 * NAIRA, // from ₦25,000 (off-store, banded)
    tagline: 'Off-store — talk to sales. Banded, never unlimited.',
    features: [
      'Everything in Wholesale',
      'Fair-use credits · API access',
      'Unlimited staff · branches',
      'Business value from ₦40M (banded, +₦20M per band)',
      'Priority support',
    ],
    productId: null,
    talkToSales: true,
    recommended: false,
    creditsPerMonth: -1, // fair-use
    staffSeats: -1, // unlimited
    bvumCeiling: 40 * M * NAIRA, // ₦40M base; extended per-business via bvumCeilingOverride (never null)
  },
];

async function main() {
  for (const p of PLANS) {
    const { id, features, bvumCeiling, ...rest } = p;
    // bvumCeiling is a BigInt column (rev 2 ceilings exceed 32-bit Int).
    const data = {
      features: features as unknown as object,
      bvumCeiling: bvumCeiling === null ? null : BigInt(bvumCeiling),
      ...rest,
    };
    await prisma.plan.upsert({
      where: { id },
      create: { id, ...data },
      update: { ...data },
    });
  }
  const count = await prisma.plan.count();
  console.log(`Seed complete: ${count} plans (${PLANS.map((p) => p.id).join(', ')})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
