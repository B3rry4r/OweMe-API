/**
 * Plan catalog seed — the 4 canonical plans (conventions.md §Metering).
 * Money is integer kobo (S-1). Idempotent: upsert by plan id, safe to re-run.
 *
 *   BVUM ceilings: starter/market ₦2M, business ₦20M, enterprise unlimited (null).
 *   -1 = fair-use / unlimited limit.
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
  sendsPerMonth: number;
  aiCreditsPerMonth: number;
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
      '10 automated SMS/WhatsApp sends / month',
      '10 AI credits / month',
    ],
    productId: null,
    talkToSales: false,
    recommended: false,
    sendsPerMonth: 10,
    aiCreditsPerMonth: 10,
    staffSeats: 0,
    bvumCeiling: 2 * M * NAIRA, // ₦2M
  },
  {
    id: 'market',
    name: 'Market',
    pricePerMonth: 2_500 * NAIRA, // ₦2,500
    tagline: 'For growing market traders.',
    features: [
      'Everything in Starter',
      '50 automated SMS/WhatsApp sends / month',
      '100 AI credits / month',
      '1 staff seat',
    ],
    productId: 'oweme_market_monthly',
    talkToSales: false,
    recommended: true,
    sendsPerMonth: 50,
    aiCreditsPerMonth: 100,
    staffSeats: 1,
    bvumCeiling: 2 * M * NAIRA, // ₦2M
  },
  {
    id: 'business',
    name: 'Business',
    pricePerMonth: 6_000 * NAIRA, // ₦6,000
    tagline: 'For established businesses managing at scale.',
    features: [
      'Everything in Market',
      '150 automated SMS/WhatsApp sends / month',
      '500 AI credits / month',
      '5 staff seats',
      'Higher business value ceiling (₦20M)',
    ],
    productId: 'oweme_business_monthly',
    talkToSales: false,
    recommended: false,
    sendsPerMonth: 150,
    aiCreditsPerMonth: 500,
    staffSeats: 5,
    bvumCeiling: 20 * M * NAIRA, // ₦20M
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    pricePerMonth: 18_000 * NAIRA, // from ₦18,000 (off-store)
    tagline: 'Off-store — talk to sales.',
    features: [
      'Everything in Business',
      'Fair-use automated sends',
      'Fair-use AI credits',
      'Unlimited staff seats',
      'No business value ceiling',
      'Priority support',
    ],
    productId: null,
    talkToSales: true,
    recommended: false,
    sendsPerMonth: -1, // fair-use
    aiCreditsPerMonth: -1, // fair-use
    staffSeats: -1, // unlimited
    bvumCeiling: null, // unlimited
  },
];

async function main() {
  for (const p of PLANS) {
    const { id, features, ...rest } = p;
    await prisma.plan.upsert({
      where: { id },
      create: { id, features: features as unknown as object, ...rest },
      update: { features: features as unknown as object, ...rest },
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
