/**
 * Admin-dashboard DEMO seed — realistic, internally consistent tenant data plus rows in
 * every admin-surface event table, so the dashboard can be wired and smoked against a
 * populated backend instead of the honest-empty state.
 *
 * Run (after `prisma migrate deploy` and the base plan seed):
 *     npm run prisma:seed        # plan catalog (prisma/seed.ts) — REQUIRED first
 *     npm run seed:admin-demo    # this file
 *
 * Properties this script guarantees:
 *   - IDEMPOTENT. Every row is upserted under a FIXED, deterministic UUIDv7-shaped id
 *     (or its natural key: businessId / phone). Re-running produces identical row counts
 *     and no unique-constraint crash. All randomness comes from a key-seeded PRNG, so a
 *     second run regenerates byte-identical values.
 *   - INTERNALLY CONSISTENT. Debt remaining = amount - sum(payments) by construction;
 *     credit balances equal grant + bundles bought this period - credits burned by the
 *     current-period usage_events rows; BVUM is computed with the real BvumService weights
 *     and calibrated per business against its effective ceiling, with EXACTLY ONE business
 *     deliberately over ceiling.
 *   - NON-DESTRUCTIVE. Nothing is deleted. Only demo-owned ids are written.
 *
 * Money is integer kobo everywhere (S-1). Ids are client-minted strings (S-2).
 *
 * SAFETY: this is demo data. Point DATABASE_URL at a scratch/dev database, never production.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
// Admin password hashing is IMPORTED from the admin auth crypto helper, never re-implemented,
// so seeded admins stay loginable if the hashing scheme ever changes.
import { hashPassword } from '../src/admin/common/admin.crypto';

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
const NAIRA = 100; // kobo
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date();

/** Start (UTC midnight, day 1) of the current calendar month — mirrors src/usage/period.util. */
const PERIOD_START = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1));

/** Credit weights — mirror src/usage/credit-ledger.service CREDIT_WEIGHTS (rev 2). */
const CREDIT_COST = { send: 5, voiceParse: 1, insight: 4 } as const;
type UsageType = keyof typeof CREDIT_COST;

/** Reporting-only kobo cost estimates stamped on usage_events (see SMS_ROUTE_COST_KOBO). */
const COST_KOBO = { send: 350, voiceParse: 120, insight: 480 } as const;

/** Base epoch for the synthetic UUIDv7 time prefix (2026-01-01T00:00:00Z). */
const UUID_BASE_MS = Date.UTC(2026, 0, 1);
const UUID_SPAN_MS = 180 * DAY_MS;

/**
 * Deterministic UUIDv7-SHAPED id: version-7 and variant nibbles are set exactly as
 * src/common/utils/uuid.ts writes them (so `isUuid` and every id validator accept it),
 * but the 48-bit time prefix and the random block are DERIVED FROM THE KEY rather than
 * from the clock. That is what makes re-running this seed hit the same rows.
 */
function fixedId(key: string): string {
  const digest = createHash('sha256').update(`oweme-admin-demo/${key}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  const ts = UUID_BASE_MS + (digest.readUInt32BE(16) % UUID_SPAN_MS);
  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = 0x70 | (bytes[6] & 0x0f); // version 7
  bytes[8] = 0x80 | (bytes[8] & 0x3f); // variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Key-seeded PRNG (mulberry32): same key -> same stream, independent of call order. */
function rngFor(key: string): () => number {
  let a = createHash('sha256').update(`rng/${key}`).digest().readUInt32BE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ago = (days: number, hour = 10): Date =>
  new Date(NOW.getTime() - days * DAY_MS + (hour - 12) * HOUR_MS);
const ahead = (days: number, hour = 10): Date =>
  new Date(NOW.getTime() + days * DAY_MS + (hour - 12) * HOUR_MS);

/** Mask every digit but the last 4, preserving length — the maskPhone idiom used in src. */
function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '*'.repeat(digits.length);
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length) % items.length];
}

// ---------------------------------------------------------------------------
// Admin users
// ---------------------------------------------------------------------------
/**
 * Documented DEV credentials (override with ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD):
 *     superadmin  admin@oweme.app        / OweMeAdmin!2026
 *     support     support@oweme.app      / OweMeSupport!2026
 * These are demo-database credentials only. The production first admin is created by
 * src/admin/auth/seed-admin.command.ts, which refuses to run once any admin exists.
 */
const DEV_ADMIN_PASSWORD = 'OweMeAdmin!2026';
const DEV_SUPPORT_PASSWORD = 'OweMeSupport!2026';

const ADMINS = [
  {
    key: 'admin:superadmin',
    email: (process.env.ADMIN_SEED_EMAIL ?? 'admin@oweme.app').toLowerCase(),
    password: process.env.ADMIN_SEED_PASSWORD ?? DEV_ADMIN_PASSWORD,
    name: 'Excel Ogbonna',
    role: 'superadmin',
    status: 'active',
    lastLoginAt: ago(0, 8),
    lastActiveAt: ago(0, 9),
  },
  {
    key: 'admin:support',
    email: (process.env.ADMIN_SUPPORT_SEED_EMAIL ?? 'support@oweme.app').toLowerCase(),
    password: process.env.ADMIN_SUPPORT_SEED_PASSWORD ?? DEV_SUPPORT_PASSWORD,
    name: 'Amarachi Bello',
    role: 'support',
    status: 'active',
    lastLoginAt: ago(1, 15),
    lastActiveAt: ago(1, 17),
  },
] as const;

// ---------------------------------------------------------------------------
// Tenant catalog — 16 Nigerian businesses across all five rev 2 plans
// ---------------------------------------------------------------------------
type PlanId = 'starter' | 'market' | 'business' | 'wholesale' | 'enterprise';
type PayoutState = 'active' | 'pending' | 'none';

interface BusinessSpec {
  key: string;
  businessName: string;
  ownerName: string;
  category: string;
  phone: string; // +234 E.164, stored verbatim like the app's signup path stores it
  plan: PlanId;
  reminderTone: 'gentle' | 'friendly' | 'final';
  isTest?: boolean;
  suspended?: boolean;
  enterpriseBands?: number;
  /** Target BVUM as a fraction of the effective ceiling. > 1 = deliberately over. */
  bvumFraction: number;
  entitlement: 'none' | 'pending' | 'active' | 'gracePeriod' | 'expired';
  payout: PayoutState;
  bankCode: string;
  customerCount: number;
  staffCount: number;
  /** Ledger period is last month's residue (untouched this month) for this business. */
  stalePeriod?: boolean;
}

const BUSINESSES: BusinessSpec[] = [
  {
    key: 'biz:adaeze-fabrics',
    businessName: 'Adaeze Fabrics and Textiles',
    ownerName: 'Adaeze Nwosu',
    category: 'Fabrics',
    phone: '+2348031472093',
    plan: 'starter',
    reminderTone: 'friendly',
    bvumFraction: 0.46,
    entitlement: 'none',
    payout: 'pending',
    bankCode: '058',
    customerCount: 6,
    staffCount: 1,
  },
  {
    key: 'biz:chinedu-auto',
    businessName: 'Chinedu Auto Spares',
    ownerName: 'Chinedu Okafor',
    category: 'Auto parts',
    phone: '+2348064820117',
    plan: 'starter',
    reminderTone: 'final',
    bvumFraction: 0.72,
    entitlement: 'none',
    payout: 'none',
    bankCode: '011',
    customerCount: 5,
    staffCount: 1,
  },
  {
    key: 'biz:mama-nkechi',
    businessName: 'Mama Nkechi Provisions',
    ownerName: 'Nkechi Eze',
    category: 'Provisions',
    phone: '+2347059338204',
    plan: 'starter',
    reminderTone: 'gentle',
    bvumFraction: 0.28,
    entitlement: 'none',
    payout: 'none',
    bankCode: '044',
    customerCount: 5,
    staffCount: 1,
  },
  {
    key: 'biz:okon-building',
    businessName: 'Okon Building Materials',
    ownerName: 'Okon Effiong',
    category: 'Building materials',
    phone: '+2348122740916',
    plan: 'starter',
    // The ONE business deliberately over its effective ceiling (starter, 300k naira).
    reminderTone: 'final',
    bvumFraction: 1.34,
    entitlement: 'none',
    payout: 'pending',
    bankCode: '070',
    customerCount: 7,
    staffCount: 1,
  },
  {
    key: 'biz:oweme-test-lagos',
    businessName: 'OweMe Test Shop Lagos',
    ownerName: 'QA Tester One',
    category: 'Internal test',
    phone: '+2349011100001',
    plan: 'starter',
    reminderTone: 'gentle',
    isTest: true,
    bvumFraction: 0.11,
    entitlement: 'none',
    payout: 'none',
    bankCode: '058',
    customerCount: 4,
    staffCount: 1,
  },
  {
    key: 'biz:zainab-cosmetics',
    businessName: 'Zainab Cosmetics Hub',
    ownerName: 'Zainab Aliyu',
    category: 'Cosmetics',
    phone: '+2348037761284',
    plan: 'market',
    reminderTone: 'friendly',
    bvumFraction: 0.55,
    entitlement: 'active',
    payout: 'active',
    bankCode: '057',
    customerCount: 7,
    staffCount: 2,
  },
  {
    key: 'biz:blessing-frozen',
    businessName: 'Blessing Frozen Foods',
    ownerName: 'Blessing Adeyemi',
    category: 'Frozen foods',
    phone: '+2348143920755',
    plan: 'market',
    reminderTone: 'gentle',
    bvumFraction: 0.83,
    entitlement: 'gracePeriod',
    payout: 'active',
    bankCode: '058',
    customerCount: 6,
    staffCount: 2,
  },
  {
    key: 'biz:amaka-tailoring',
    businessName: 'Amaka Tailoring House',
    ownerName: 'Amaka Obi',
    category: 'Tailoring',
    phone: '+2347031884502',
    plan: 'market',
    reminderTone: 'friendly',
    // Suspended tenant (gap-5 suspension lifecycle state).
    suspended: true,
    bvumFraction: 0.39,
    entitlement: 'expired',
    payout: 'pending',
    bankCode: '032',
    customerCount: 5,
    staffCount: 2,
    stalePeriod: true,
  },
  {
    key: 'biz:oweme-test-ph',
    businessName: 'OweMe Test Depot Port Harcourt',
    ownerName: 'QA Tester Two',
    category: 'Internal test',
    phone: '+2349011100002',
    plan: 'market',
    reminderTone: 'friendly',
    isTest: true,
    bvumFraction: 0.24,
    entitlement: 'active',
    payout: 'none',
    bankCode: '044',
    customerCount: 4,
    staffCount: 2,
  },
  {
    key: 'biz:emeka-electronics',
    businessName: 'Emeka Electronics Plaza',
    ownerName: 'Emeka Nnaji',
    category: 'Electronics',
    phone: '+2348028830461',
    plan: 'business',
    reminderTone: 'final',
    bvumFraction: 0.68,
    entitlement: 'active',
    payout: 'active',
    bankCode: '011',
    customerCount: 8,
    staffCount: 4,
  },
  {
    key: 'biz:tolu-pharmacy',
    businessName: 'Tolu Pharmacy Stores',
    ownerName: 'Tolulope Ajayi',
    category: 'Pharmacy',
    phone: '+2348156402287',
    plan: 'business',
    reminderTone: 'gentle',
    bvumFraction: 0.41,
    entitlement: 'active',
    payout: 'active',
    bankCode: '070',
    customerCount: 7,
    staffCount: 3,
  },
  {
    key: 'biz:ibadan-poultry',
    businessName: 'Ibadan Poultry Supplies',
    ownerName: 'Segun Alabi',
    category: 'Agriculture',
    phone: '+2347066915330',
    plan: 'business',
    reminderTone: 'friendly',
    bvumFraction: 0.87,
    entitlement: 'pending',
    payout: 'pending',
    bankCode: '057',
    customerCount: 8,
    staffCount: 3,
  },
  {
    key: 'biz:uche-beverages',
    businessName: 'Uche Wholesale Beverages',
    ownerName: 'Uchechi Duru',
    category: 'Beverages',
    phone: '+2348039912047',
    plan: 'wholesale',
    reminderTone: 'final',
    bvumFraction: 0.62,
    entitlement: 'active',
    payout: 'active',
    bankCode: '058',
    customerCount: 8,
    staffCount: 5,
  },
  {
    key: 'biz:kano-grains',
    businessName: 'Kano Grains Depot',
    ownerName: 'Musa Danladi',
    category: 'Grains',
    phone: '+2348181137624',
    plan: 'wholesale',
    reminderTone: 'friendly',
    bvumFraction: 0.91,
    entitlement: 'active',
    payout: 'active',
    bankCode: '011',
    customerCount: 8,
    staffCount: 5,
  },
  {
    key: 'biz:sunrise-cement',
    businessName: 'Sunrise Cement Distribution Ltd',
    ownerName: 'Ifeanyi Madu',
    category: 'Cement distribution',
    phone: '+2348023308871',
    plan: 'enterprise',
    reminderTone: 'final',
    // Banded enterprise: 2 bands over the 40M naira base -> 80M naira effective ceiling.
    enterpriseBands: 2,
    bvumFraction: 0.58,
    entitlement: 'active',
    payout: 'active',
    bankCode: '044',
    customerCount: 8,
    staffCount: 6,
  },
  {
    key: 'biz:delta-steel',
    businessName: 'Delta Steel Trading Company',
    ownerName: 'Ovie Tanure',
    category: 'Steel trading',
    phone: '+2348077452190',
    plan: 'enterprise',
    reminderTone: 'friendly',
    bvumFraction: 0.74,
    entitlement: 'active',
    payout: 'pending',
    bankCode: '032',
    customerCount: 8,
    staffCount: 6,
  },
];

const CUSTOMER_NAMES = [
  'Ifeoma Chukwu', 'Bala Mohammed', 'Grace Etim', 'Kelechi Anyanwu', 'Halima Sani',
  'Tunde Bakare', 'Rita Umeh', 'Suleiman Yusuf', 'Peace Akpan', 'Gbenga Falade',
  'Chiamaka Iwu', 'Yakubu Garba', 'Esther Onoja', 'Femi Adebayo', 'Ngozi Nwachukwu',
  'Aisha Lawal', 'Daniel Ekpo', 'Joy Oshodi', 'Ibrahim Bello', 'Chidera Nwoke',
];

const STAFF_NAMES = [
  'Samuel Idowu', 'Fatima Abubakar', 'Precious Ndukwe', 'Bright Osaro', 'Hauwa Kabir',
  'Victor Ogadi', 'Salome Terna', 'Kunle Ajibade',
];

const ADDRESSES = [
  'Shop 12, Alaba International Market, Lagos',
  '4 Aba Road, Port Harcourt',
  'Plot 8, Sabon Gari Market, Kano',
  '21 Ogui Road, Enugu',
  'Suite 5, Wuse II, Abuja',
  '17 Dugbe Market Road, Ibadan',
  'No 3 Nkwo Lane, Onitsha',
  '9 Marian Road, Calabar',
];

const DEBT_NOTES = [
  'Bulk supply on credit', 'Weekly restock', 'Balance from last delivery',
  'Ordered on trust, pay after market day', 'Two cartons taken', 'Half payment made on pickup',
  'Goods collected for the shop', 'Supply for the December sales',
];

// ---------------------------------------------------------------------------
// Debt templates (unit amounts; scaled per business to hit the BVUM target)
// ---------------------------------------------------------------------------
type DebtState = 'open' | 'partial' | 'overdue' | 'paid' | 'deleted';

interface DebtTemplate {
  state: DebtState;
  units: number; // relative principal, scaled per business
  ageDays: number; // createdAt = ageDays ago
  dueOffsetDays: number; // dueDate relative to now (negative = past due)
  /** Fractions of the principal, in order. 'paid' is normalized to exactly 1.0 total. */
  paymentFracs: number[];
  /** Index into paymentFracs recorded with method 'Paystack link' (webhook-originated). */
  paystackIndex?: number;
}

/** Deterministic per-business debt mix. Always contains every state incl. one soft-deleted. */
function debtTemplates(count: number, rng: () => number): DebtTemplate[] {
  const base: DebtTemplate[] = [
    { state: 'open', units: 120, ageDays: 9, dueOffsetDays: 12, paymentFracs: [] },
    { state: 'partial', units: 180, ageDays: 21, dueOffsetDays: 8, paymentFracs: [0.35], paystackIndex: 0 },
    { state: 'overdue', units: 260, ageDays: 47, dueOffsetDays: -16, paymentFracs: [0.2] },
    { state: 'paid', units: 90, ageDays: 34, dueOffsetDays: -4, paymentFracs: [0.6, 0.4], paystackIndex: 1 },
    { state: 'deleted', units: 70, ageDays: 62, dueOffsetDays: -30, paymentFracs: [] },
    { state: 'open', units: 150, ageDays: 3, dueOffsetDays: 21, paymentFracs: [] },
    { state: 'overdue', units: 210, ageDays: 73, dueOffsetDays: -41, paymentFracs: [] },
    { state: 'partial', units: 240, ageDays: 15, dueOffsetDays: 5, paymentFracs: [0.25, 0.2] },
    { state: 'paid', units: 130, ageDays: 11, dueOffsetDays: 2, paymentFracs: [1.0], paystackIndex: 0 },
    { state: 'open', units: 100, ageDays: 27, dueOffsetDays: 30, paymentFracs: [] },
  ];
  const out = base.slice(0, Math.max(5, Math.min(count, base.length)));
  // Vary the principals a little without touching the state mix (scaling is applied later).
  return out.map((t) => ({ ...t, units: Math.round(t.units * (0.8 + rng() * 0.5)) }));
}

/** Payments implied by a template at a given (scaled) principal. Never exceeds the principal. */
function paymentsFor(t: DebtTemplate, amount: number): { amount: number; ageDays: number }[] {
  if (t.paymentFracs.length === 0) return [];
  if (t.state === 'paid') {
    // Exactly the principal, split across the listed fractions (last absorbs the remainder).
    const parts = t.paymentFracs.map((f) => Math.floor(amount * f));
    parts[parts.length - 1] += amount - parts.reduce((s, p) => s + p, 0);
    return parts.map((p, i) => ({ amount: p, ageDays: Math.max(1, t.ageDays - (i + 1) * 3) }));
  }
  let left = amount - 1; // keep at least 1 kobo outstanding for non-paid states
  return t.paymentFracs.map((f, i) => {
    const value = Math.max(1, Math.min(left, Math.floor(amount * f)));
    left -= value;
    return { amount: value, ageDays: Math.max(1, t.ageDays - (i + 1) * 4) };
  });
}

/**
 * BVUM value — a faithful copy of the pure `computeValue` in src/bvum/bvum.service.ts
 * (weights and 30-day window). Duplicated read-only so the seed can CALIBRATE against the
 * real formula; the service itself is never imported (it is a Nest provider) or modified.
 */
const BVUM_WEIGHTS = {
  receivables: 0.4,
  creditIssued: 0.3,
  recovery: 0.15,
  activeDebtors: 0.1,
  complexity: 0.05,
} as const;

interface BvumDebt {
  amount: number;
  createdAt: Date;
  customerId: string;
  payments: { amount: number; createdAt: Date }[];
}

function computeBvum(debts: BvumDebt[]): number {
  const windowStart = new Date(NOW.getTime() - 30 * DAY_MS);
  let receivables = 0;
  let creditIssued = 0;
  let recovery = 0;
  let totalPrincipal = 0;
  let openDebts = 0;
  const activeCustomers = new Set<string>();

  for (const debt of debts) {
    const paid = debt.payments.reduce((s, p) => s + p.amount, 0);
    const remaining = Math.max(0, debt.amount - paid);
    receivables += remaining;
    totalPrincipal += debt.amount;
    if (debt.createdAt >= windowStart) creditIssued += debt.amount;
    for (const p of debt.payments) if (p.createdAt >= windowStart) recovery += p.amount;
    if (remaining > 0) {
      openDebts += 1;
      activeCustomers.add(debt.customerId);
    }
  }
  const avgTicket = debts.length > 0 ? Math.round(totalPrincipal / debts.length) : 0;
  return Math.round(
    BVUM_WEIGHTS.receivables * receivables +
      BVUM_WEIGHTS.creditIssued * creditIssued +
      BVUM_WEIGHTS.recovery * recovery +
      BVUM_WEIGHTS.activeDebtors * (activeCustomers.size * avgTicket) +
      BVUM_WEIGHTS.complexity * (openDebts * avgTicket),
  );
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------
interface PlanRow {
  id: string;
  productId: string | null;
  pricePerMonth: number;
  creditsPerMonth: number;
  bvumCeiling: bigint | null;
}

async function seedAdmins(): Promise<{ superId: string; supportId: string }> {
  const ids: string[] = [];
  for (const admin of ADMINS) {
    const id = fixedId(admin.key);
    ids.push(id);
    const data = {
      email: admin.email,
      name: admin.name,
      // Hashed with the SAME helper the admin auth service uses (salted scrypt).
      passwordHash: hashPassword(admin.password),
      role: admin.role,
      status: admin.status,
      mustChangePassword: false,
      lastLoginAt: admin.lastLoginAt,
      lastActiveAt: admin.lastActiveAt,
    };
    // Upsert on the fixed id; a pre-existing row with the same EMAIL but another id would
    // violate the unique index, so clear that case first (idempotent across seed variants).
    const clash = await prisma.adminUser.findUnique({ where: { email: admin.email } });
    if (clash && clash.id !== id) {
      await prisma.adminRefreshToken.deleteMany({ where: { adminUserId: clash.id } });
      await prisma.adminUser.delete({ where: { id: clash.id } });
    }
    await prisma.adminUser.upsert({ where: { id }, create: { id, ...data }, update: data });
  }
  return { superId: ids[0], supportId: ids[1] };
}

interface BusinessResult {
  id: string;
  spec: BusinessSpec;
  bvum: number;
  ceiling: number;
  /** A real open debt id + a partial payment amount, for the replayable Paystack error row. */
  replayDebtId: string;
  replayAmount: number;
  creditsBurnedThisPeriod: number;
  bundleCreditsThisPeriod: number;
  balance: number;
}

async function seedBusiness(spec: BusinessSpec, plans: Map<string, PlanRow>): Promise<BusinessResult> {
  const rng = rngFor(spec.key);
  const businessId = fixedId(spec.key);
  const plan = plans.get(spec.plan)!;

  // --- effective ceiling (enterprise banding: base + 20M naira per band) -------------
  const baseCeiling = Number(plan.bvumCeiling ?? 0);
  const bands = spec.enterpriseBands ?? 0;
  const ceilingOverride = bands > 0 ? BigInt(baseCeiling + bands * 20_000_000 * NAIRA) : null;
  const effectiveCeiling = ceilingOverride === null ? baseCeiling : Number(ceilingOverride);

  const businessData = {
    businessName: spec.businessName,
    ownerName: spec.ownerName,
    phone: spec.phone,
    category: spec.category,
    currency: 'NGN (₦)',
    reminderTone: spec.reminderTone,
    plan: spec.plan,
    bvumCeilingOverride: ceilingOverride,
    paystackSubaccount: spec.payout === 'active' ? `ACCT_${fixedId(`${spec.key}:sub`).slice(0, 10)}` : null,
    logoUrl: null,
    branchId: null,
    createdAt: ago(120 + Math.floor(rng() * 400)),
    isTest: spec.isTest ?? false,
    enterpriseBands: bands,
    suspendedAt: spec.suspended ? ago(6, 14) : null,
  };
  await prisma.business.upsert({
    where: { id: businessId },
    create: { id: businessId, ...businessData },
    update: businessData,
  });

  // --- staff (owner + team; owner phone == business phone, as resolveAccount expects) --
  const ops: Prisma.PrismaPromise<unknown>[] = [];
  for (let s = 0; s < spec.staffCount; s++) {
    const staffId = fixedId(`${spec.key}:staff:${s}`);
    const isOwner = s === 0;
    const data = {
      businessId,
      name: isOwner ? spec.ownerName : STAFF_NAMES[(s + spec.customerCount) % STAFF_NAMES.length],
      phone: isOwner ? spec.phone : `+234${800 + s}${String(1000000 + Math.floor(rng() * 8999999))}`,
      role: isOwner ? 'owner' : 'staff',
      active: s < spec.staffCount - 1 || spec.staffCount === 1, // last seat of a team is inactive
      createdAt: ago(115 - s * 7),
    };
    ops.push(prisma.staff.upsert({ where: { id: staffId }, create: { id: staffId, ...data }, update: data }));
  }

  // --- customers (last one soft-deleted) ----------------------------------------------
  const customerIds: string[] = [];
  for (let c = 0; c < spec.customerCount; c++) {
    const customerId = fixedId(`${spec.key}:customer:${c}`);
    customerIds.push(customerId);
    const deleted = c === spec.customerCount - 1;
    const data = {
      businessId,
      name: CUSTOMER_NAMES[(c * 3 + spec.customerCount) % CUSTOMER_NAMES.length],
      phone: `+234${pick(rng, ['803', '806', '705', '813', '905'])}${String(1000000 + Math.floor(rng() * 8999999))}`,
      address: pick(rng, ADDRESSES),
      note: c % 3 === 0 ? 'Regular customer, pays after market day' : null,
      deleted,
      createdAt: ago(110 - c * 6),
    };
    ops.push(
      prisma.customer.upsert({ where: { id: customerId }, create: { id: customerId, ...data }, update: data }),
    );
  }
  await prisma.$transaction(ops);

  // --- debts + payments: calibrate principals so BVUM lands on the target fraction -----
  const templates = debtTemplates(spec.customerCount + 1, rng);
  const unitDebts: BvumDebt[] = templates
    .filter((t) => t.state !== 'deleted') // deleted debts are excluded from BVUM (deleted:false)
    .map((t, i) => ({
      amount: t.units,
      createdAt: ago(t.ageDays),
      customerId: customerIds[i % customerIds.length],
      payments: paymentsFor(t, t.units).map((p) => ({ amount: p.amount, createdAt: ago(p.ageDays) })),
    }));
  const unitValue = computeBvum(unitDebts);
  const targetValue = effectiveCeiling * spec.bvumFraction;
  // Scale to the nearest whole naira so the amounts read like real prices.
  const scale = unitValue > 0 ? targetValue / unitValue : 1;

  let receiptSeq = 0;
  const realDebts: BvumDebt[] = [];
  let replayDebtId = '';
  let replayAmount = 0;
  const debtOps: Prisma.PrismaPromise<unknown>[] = [];

  for (let d = 0; d < templates.length; d++) {
    const t = templates[d];
    const debtId = fixedId(`${spec.key}:debt:${d}`);
    const customerId = customerIds[d % customerIds.length];
    const amount = Math.max(NAIRA, Math.round((t.units * scale) / NAIRA) * NAIRA);
    const createdAt = ago(t.ageDays);
    const payments = paymentsFor(t, amount);
    const paidTotal = payments.reduce((s, p) => s + p.amount, 0);
    const settled = paidTotal >= amount;

    const debtData = {
      businessId,
      customerId,
      amount,
      note: DEBT_NOTES[(d + spec.customerCount) % DEBT_NOTES.length],
      dueDate: t.dueOffsetDays >= 0 ? ahead(t.dueOffsetDays) : ago(-t.dueOffsetDays),
      createdAt,
      lastReminderAt: t.state === 'open' ? null : ago(Math.max(1, t.ageDays - 6)),
      // Settled and soft-deleted debts carry no schedule (the app clears it on settlement).
      nextReminderAt: settled || t.state === 'deleted' ? null : ahead(2 + (d % 5)),
      deleted: t.state === 'deleted',
    };
    debtOps.push(
      prisma.debt.upsert({ where: { id: debtId }, create: { id: debtId, ...debtData }, update: debtData }),
    );

    for (let p = 0; p < payments.length; p++) {
      const paymentId = fixedId(`${spec.key}:payment:${d}:${p}`);
      const viaPaystack = t.paystackIndex === p;
      receiptSeq += 1;
      const paymentData = {
        businessId,
        debtId,
        amount: payments[p].amount,
        // 'Paystack link' is the verbatim method the webhook reconciliation writes.
        method: viaPaystack ? 'Paystack link' : pick(rng, ['Cash', 'Transfer', 'POS']),
        reference: viaPaystack
          ? `PSK_${fixedId(`${spec.key}:psk:${d}:${p}`).replace(/-/g, '').slice(0, 12)}`
          : `OWM-${String(receiptSeq).padStart(5, '0')}`,
        createdAt: ago(payments[p].ageDays),
      };
      debtOps.push(
        prisma.payment.upsert({
          where: { id: paymentId },
          create: { id: paymentId, ...paymentData },
          update: paymentData,
        }),
      );
    }

    // --- reminders across every status/channel ---------------------------------------
    if (t.state !== 'deleted') {
      const reminderPlan: {
        status: 'sent' | 'scheduled' | 'failed';
        channel: string;
        offset: number;
      }[] = [
        { status: 'sent', channel: 'sms', offset: Math.max(1, t.ageDays - 5) },
        ...(d % 3 === 0 ? [{ status: 'failed' as const, channel: 'whatsapp', offset: Math.max(1, t.ageDays - 2) }] : []),
        ...(settled ? [] : [{ status: 'scheduled' as const, channel: d % 2 === 0 ? 'sms' : 'whatsapp', offset: -(2 + (d % 5)) }]),
        ...(d % 4 === 1 ? [{ status: 'sent' as const, channel: 'manual', offset: Math.max(1, t.ageDays - 9) }] : []),
        ...(d % 5 === 2 ? [{ status: 'sent' as const, channel: 'printable', offset: Math.max(1, t.ageDays - 12) }] : []),
      ];
      for (let r = 0; r < reminderPlan.length; r++) {
        const item = reminderPlan[r];
        const reminderId = fixedId(`${spec.key}:reminder:${d}:${r}`);
        const at = item.offset >= 0 ? ago(item.offset) : ahead(-item.offset);
        const reminderData = {
          businessId,
          debtId,
          channel: item.channel,
          status: item.status,
          message:
            item.status === 'failed'
              ? 'Delivery failed at the provider route (DND restricted number)'
              : `Good day, a balance of ${Math.round(amount / NAIRA).toLocaleString('en-NG')} naira is outstanding with ${spec.businessName}.`,
          scheduledFor: item.status === 'scheduled' ? at : null,
          sentAt: item.status === 'sent' ? at : null,
          // Pay links only ride the metered channels, matching the app's pay-link flow.
          payLinkUrl:
            item.channel === 'sms' || item.channel === 'whatsapp'
              ? `https://paystack.test/pay/PL_${fixedId(`${spec.key}:link:${d}:${r}`).replace(/-/g, '').slice(0, 10)}`
              : null,
          createdAt: at,
        };
        debtOps.push(
          prisma.reminder.upsert({
            where: { id: reminderId },
            create: { id: reminderId, ...reminderData },
            update: reminderData,
          }),
        );
      }
      realDebts.push({
        amount,
        createdAt,
        customerId,
        payments: payments.map((p) => ({ amount: p.amount, createdAt: ago(p.ageDays) })),
      });
      if (t.state === 'open' && replayDebtId === '') {
        replayDebtId = debtId;
        replayAmount = Math.round((amount * 0.3) / NAIRA) * NAIRA || NAIRA;
      }
    }
  }
  await prisma.$transaction(debtOps);

  // --- notifications + preferences ----------------------------------------------------
  const notifOps: Prisma.PrismaPromise<unknown>[] = [];
  const notifications = [
    { kind: 'payment', title: 'Payment received', body: 'A pay-link payment was recorded against an open debt.', days: 2, read: true },
    { kind: 'overdue', title: 'Debt overdue', body: 'A debt passed its due date and is now overdue.', days: 5, read: false },
    { kind: 'insight', title: 'Weekly insight ready', body: 'Your recovery rate improved compared with last week.', days: 9, read: false },
  ];
  for (let n = 0; n < notifications.length; n++) {
    const item = notifications[n];
    const notifId = fixedId(`${spec.key}:notification:${n}`);
    const data = {
      businessId,
      title: item.title,
      body: item.body,
      kind: item.kind,
      read: item.read,
      createdAt: ago(item.days),
    };
    notifOps.push(
      prisma.notification.upsert({ where: { id: notifId }, create: { id: notifId, ...data }, update: data }),
    );
  }
  const prefs = { payments: true, overdue: true, delivery: spec.plan !== 'starter', weekly: spec.plan === 'wholesale' || spec.plan === 'enterprise' };
  notifOps.push(
    prisma.notificationPreferences.upsert({
      where: { businessId },
      create: { businessId, ...prefs },
      update: prefs,
    }),
  );

  // --- payout account ------------------------------------------------------------------
  // NOTE: PayoutAccount has no status column. The admin payouts panel derives
  // `subaccountActive` from Business.paystackSubaccount, so the three demo states are:
  //   active  = row + subaccount code, pending = row without a subaccount, none = no row.
  if (spec.payout !== 'none') {
    const accountNumber = String(1000000000 + Math.floor(rng() * 8999999999)).slice(0, 10);
    const payout = {
      bankCode: spec.bankCode,
      accountNumber,
      accountName: spec.ownerName.toUpperCase(),
    };
    notifOps.push(
      prisma.payoutAccount.upsert({
        where: { businessId },
        create: { businessId, ...payout },
        update: payout,
      }),
    );
  }

  // --- subscription --------------------------------------------------------------------
  const subscription = {
    planId: spec.plan,
    entitlementState: spec.entitlement,
    activePlanId: spec.entitlement === 'expired' ? 'starter' : spec.plan,
    renewalAt:
      spec.entitlement === 'active'
        ? ahead(3 + Math.floor(rng() * 25))
        : spec.entitlement === 'gracePeriod'
          ? ago(2)
          : null,
  };
  notifOps.push(
    prisma.subscription.upsert({
      where: { businessId },
      create: { businessId, ...subscription },
      update: subscription,
    }),
  );

  // --- usage events over the last 12 weeks ---------------------------------------------
  // Current-period events are capped so the ledger balance stays non-negative and exactly
  // equal to grant + bundle credits - burned (see the ledger write below).
  const bundleSpecs = bundlePurchasesFor(spec, rng);
  const bundleCreditsThisPeriod = bundleSpecs
    .filter((b) => b.createdAt >= PERIOD_START)
    .reduce((s, b) => s + b.credits, 0);
  const grant = plan.creditsPerMonth; // -1 = fair-use (enterprise)
  const spendable = grant === -1 ? Number.MAX_SAFE_INTEGER : grant + bundleCreditsThisPeriod;

  const usageOps: Prisma.PrismaPromise<unknown>[] = [];
  let burnedThisPeriod = 0;
  const weeks = 12;
  const perWeek = 3 + Math.floor(rng() * 4);
  for (let w = 0; w < weeks; w++) {
    for (let e = 0; e < perWeek; e++) {
      const usageId = fixedId(`${spec.key}:usage:${w}:${e}`);
      const type: UsageType = e % 5 === 3 ? 'insight' : e % 3 === 1 ? 'voiceParse' : 'send';
      const createdAt = ago(w * 7 + (e % 7), 8 + (e % 10));
      const credits = CREDIT_COST[type];
      const inPeriod = createdAt >= PERIOD_START;
      // Budget guard: never let this period's burn exceed what the ledger can fund.
      if (inPeriod && burnedThisPeriod + credits > spendable) continue;
      if (inPeriod) burnedThisPeriod += credits;
      const data = {
        businessId,
        type,
        credits,
        costKoboEstimate:
          type === 'send' ? COST_KOBO.send * (1 + (e % 2)) : COST_KOBO[type],
        // Metadata ONLY. Transcripts are NEVER stored (metadata-only ruling).
        meta:
          type === 'send'
            ? { channel: e % 2 === 0 ? 'sms' : 'whatsapp', pages: 1 + (e % 2) }
            : type === 'voiceParse'
              ? { durationMs: 3200 + e * 450, language: 'en-NG', parsed: true }
              : { insightKind: e % 2 === 0 ? 'weekly-summary' : 'customer-risk' },
        createdAt,
      };
      usageOps.push(
        prisma.usageEvent.upsert({ where: { id: usageId }, create: { id: usageId, ...data }, update: data }),
      );
    }
  }

  // --- billing transactions: subscription renewals + credits bundles ---------------------
  if (plan.productId !== null && spec.entitlement !== 'none') {
    for (let m = 0; m < 3; m++) {
      const txId = fixedId(`${spec.key}:sub-tx:${m}`);
      const data = {
        businessId,
        kind: 'subscription',
        productId: plan.productId,
        label: `${spec.plan.charAt(0).toUpperCase() + spec.plan.slice(1)} plan renewal`,
        amount: plan.pricePerMonth,
        createdAt: ago(m * 30 + 4, 11),
      };
      usageOps.push(
        prisma.billingTransaction.upsert({ where: { id: txId }, create: { id: txId, ...data }, update: data }),
      );
    }
  }
  for (const bundle of bundleSpecs) {
    const data = {
      businessId,
      kind: 'credits-bundle',
      productId: bundle.productId,
      label: bundle.label,
      amount: bundle.amountKobo,
      createdAt: bundle.createdAt,
    };
    usageOps.push(
      prisma.billingTransaction.upsert({
        where: { id: bundle.id },
        create: { id: bundle.id, ...data },
        update: data,
      }),
    );
  }

  // --- credit ledger, consistent with the current-period usage events -------------------
  const balance = grant === -1 ? 0 : Math.max(0, grant + bundleCreditsThisPeriod - burnedThisPeriod);
  const ledger = {
    balance,
    monthlyGrant: grant,
    // A stale periodStart models last month's untouched residue (the credits panel
    // deliberately excludes those ledgers from this month's derivation).
    periodStart: spec.stalePeriod ? new Date(Date.UTC(PERIOD_START.getUTCFullYear(), PERIOD_START.getUTCMonth() - 1, 1)) : PERIOD_START,
  };
  usageOps.push(
    prisma.creditLedger.upsert({ where: { businessId }, create: { businessId, ...ledger }, update: ledger }),
  );

  await prisma.$transaction([...notifOps, ...usageOps]);

  return {
    id: businessId,
    spec,
    bvum: computeBvum(realDebts),
    ceiling: effectiveCeiling,
    replayDebtId,
    replayAmount,
    creditsBurnedThisPeriod: burnedThisPeriod,
    bundleCreditsThisPeriod,
    balance,
  };
}

interface BundlePurchase {
  id: string;
  productId: string;
  label: string;
  amountKobo: number;
  credits: number;
  createdAt: Date;
}

/** Bundle top-ups, respecting the rev 2 hard cap of 2 purchases per calendar month. */
function bundlePurchasesFor(spec: BusinessSpec, rng: () => number): BundlePurchase[] {
  const catalog = [
    { productId: 'oweme_credits_250', label: '250 OweMe credits', amountKobo: 2_000 * NAIRA, credits: 250 },
    { productId: 'oweme_credits_600', label: '600 OweMe credits', amountKobo: 4_000 * NAIRA, credits: 600 },
    { productId: 'oweme_credits_1500', label: '1,500 OweMe credits', amountKobo: 8_000 * NAIRA, credits: 1_500 },
  ];
  // Free/suspended/fair-use tenants do not top up; the rest buy 1 to 2 bundles this month.
  if (spec.plan === 'starter' || spec.plan === 'enterprise' || spec.suspended) return [];
  const count = rng() > 0.5 ? 2 : 1;
  const out: BundlePurchase[] = [];
  for (let i = 0; i < count; i++) {
    const item = catalog[(i + spec.customerCount) % catalog.length];
    // Inside the current calendar month, and never in the future.
    const dayOfMonth = Math.min(NOW.getUTCDate(), 2 + i * 5);
    const createdAt = new Date(
      Date.UTC(PERIOD_START.getUTCFullYear(), PERIOD_START.getUTCMonth(), dayOfMonth, 12 + i),
    );
    out.push({ id: fixedId(`${spec.key}:bundle:${i}`), ...item, createdAt });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Event tables: OTP logs, test codes, webhook log, audit log
// ---------------------------------------------------------------------------
async function seedOtpLogs(results: BusinessResult[]): Promise<void> {
  const rng = rngFor('otp-log');
  const ops: Prisma.PrismaPromise<unknown>[] = [];
  const outcomes: { outcome: string; weight: number }[] = [
    { outcome: 'requested', weight: 5 },
    { outcome: 'verified', weight: 4 },
    { outcome: 'delivered-unknown', weight: 2 },
    { outcome: 'failed', weight: 2 },
    { outcome: 'rate-limited', weight: 1 },
  ];
  const bag: string[] = [];
  for (const o of outcomes) for (let i = 0; i < o.weight; i++) bag.push(o.outcome);

  for (let day = 0; day < 14; day++) {
    const perDay = 4 + Math.floor(rng() * 7);
    for (let i = 0; i < perDay; i++) {
      const logId = fixedId(`otp:${day}:${i}`);
      const target = results[(day * 3 + i) % results.length];
      // Two thirds of the traffic is attributable to a known tenant; the rest is a
      // first-time / unknown phone, exactly as the live instrumentation records it.
      const attributed = (day + i) % 3 !== 2;
      const outcome = bag[(day * 5 + i * 3) % bag.length];
      const phone = attributed
        ? target.spec.phone
        : `+234${pick(rng, ['803', '706', '814'])}${String(1000000 + Math.floor(rng() * 8999999))}`;
      const data = {
        // Phones are stored MASKED only; full numbers never enter this log.
        phoneMasked: maskPhone(phone),
        businessId: attributed ? target.id : null,
        outcome,
        attempts: outcome === 'failed' ? 1 + (i % 4) : outcome === 'rate-limited' ? 5 : 0,
        createdAt: ago(day, 7 + (i % 12)),
      };
      ops.push(
        prisma.otpRequestLog.upsert({ where: { id: logId }, create: { id: logId, ...data }, update: data }),
      );
    }
  }
  await prisma.$transaction(ops);
}

/**
 * Plaintext OTP codes for the TEST-flagged businesses ONLY (conventions power 2). Keyed by
 * phone, so re-running refreshes the expiry instead of inserting a second row.
 *
 * The live TTL is 10 minutes; the demo rows are given a longer window so a dashboard smoke
 * session can actually exercise the reveal without re-seeding.
 */
async function seedOtpTestCodes(results: BusinessResult[]): Promise<number> {
  const testBusinesses = results.filter((r) => r.spec.isTest);
  const expiresAt = new Date(NOW.getTime() + 12 * HOUR_MS);
  for (let i = 0; i < testBusinesses.length; i++) {
    const phone = testBusinesses[i].spec.phone;
    const codePlain = String(100000 + (parseInt(fixedId(`otp-code:${phone}`).slice(0, 6), 16) % 899999));
    await prisma.otpTestCode.upsert({
      where: { phone },
      create: { phone, codePlain, expiresAt },
      update: { codePlain, expiresAt },
    });
  }
  return testBusinesses.length;
}

async function seedWebhookLog(results: BusinessResult[]): Promise<void> {
  const ops: Prisma.PrismaPromise<unknown>[] = [];
  const paidBusinesses = results.filter((r) => r.spec.plan !== 'starter' && !r.spec.suspended);

  const push = (
    key: string,
    source: string,
    eventType: string,
    reference: string | null,
    outcome: string,
    detail: Prisma.InputJsonValue | null,
    days: number,
  ) => {
    const id = fixedId(key);
    const data = { source, eventType, reference, outcome, detail: detail ?? Prisma.JsonNull, createdAt: ago(days, 9 + (days % 10)) };
    ops.push(
      prisma.webhookEventLog.upsert({ where: { id }, create: { id, ...data }, update: data }),
    );
  };

  // --- ok / ignored traffic ------------------------------------------------------------
  for (let i = 0; i < 10; i++) {
    const target = results[(i * 3) % results.length];
    push(
      `webhook:paystack:ok:${i}`,
      'paystack',
      'charge.success',
      `PSK_${fixedId(`webhook:ref:${i}`).replace(/-/g, '').slice(0, 12)}`,
      i % 4 === 3 ? 'ignored' : 'ok',
      { businessId: target.id, processed: i % 4 !== 3 },
      i + 1,
    );
  }
  for (let i = 0; i < 4; i++) {
    push(
      `webhook:paystack:ignored:${i}`,
      'paystack',
      pick(rngFor(`wh:${i}`), ['transfer.success', 'charge.dispute.create', 'subscription.disable']),
      null,
      'ignored',
      { reason: 'Verified event with no reconciliation path' },
      3 + i * 2,
    );
  }
  for (let i = 0; i < 6; i++) {
    const target = paidBusinesses[i % paidBusinesses.length];
    push(
      `webhook:iap:ok:${i}`,
      'iap',
      pick(rngFor(`iap:${i}`), ['DID_RENEW', 'SUBSCRIBED', 'DID_CHANGE_RENEWAL_STATUS']),
      `stub-txn-${fixedId(`iap:ref:${i}`).slice(0, 16)}`,
      i % 3 === 2 ? 'ignored' : 'ok',
      { businessId: target.id, processed: i % 3 !== 2 },
      2 + i,
    );
  }

  // --- ERROR rows, retained with a REPLAYABLE envelope --------------------------------
  // detail contract: payload + rawBody + signature (paystack) / payload (iap), per
  // src/admin/webhook-actions/admin-webhook-actions.views.ts WebhookReplayEnvelope.
  const replayTarget = results.find((r) => r.replayDebtId !== '')!;
  const replayRef = `PSK_${fixedId('webhook:replay:ref:1').replace(/-/g, '').slice(0, 12)}`;
  const replayPayload = {
    event: 'charge.success',
    data: {
      reference: replayRef,
      amount: replayTarget.replayAmount,
      metadata: {
        debtId: replayTarget.replayDebtId,
        businessId: replayTarget.id,
      },
    },
  };
  push(
    'webhook:paystack:error:1',
    'paystack',
    'charge.success',
    replayRef,
    'error',
    {
      message: 'Error: database is locked (transient); the verified charge was not recorded',
      businessId: replayTarget.id,
      payload: replayPayload,
      rawBody: JSON.stringify(replayPayload),
      // The captured x-paystack-signature. The replay path re-verifies it through the
      // live gateway; the dev stub gateway accepts it, so a demo replay reconciles for real.
      signature: createHash('sha512').update(JSON.stringify(replayPayload)).digest('hex'),
    },
    2,
  );

  const orphanRef = `PSK_${fixedId('webhook:replay:ref:2').replace(/-/g, '').slice(0, 12)}`;
  const orphanPayload = {
    event: 'charge.success',
    data: {
      reference: orphanRef,
      amount: 250_000,
      metadata: { debtId: fixedId('webhook:unknown-debt'), businessId: results[0].id },
    },
  };
  push(
    'webhook:paystack:error:2',
    'paystack',
    'charge.success',
    orphanRef,
    'error',
    {
      message: 'Error: pay-link metadata referenced a debt that no longer exists',
      businessId: results[0].id,
      payload: orphanPayload,
      rawBody: JSON.stringify(orphanPayload),
      signature: createHash('sha512').update(JSON.stringify(orphanPayload)).digest('hex'),
    },
    5,
  );

  // IAP error row. `receipt` is chosen so the stub verifier's derived transaction id
  // (`stub-txn-<first 16 chars>`) matches the BillingTransaction seeded below, giving the
  // replay a real server-side tenant binding to land on.
  const iapTarget = paidBusinesses[0];
  const iapReceipt = fixedId('webhook:iap-receipt').replace(/-/g, '');
  const iapTxnId = `stub-txn-${iapReceipt.slice(0, 16)}`;
  const iapPlan = iapTarget.spec.plan;
  const iapBinding = {
    businessId: iapTarget.id,
    kind: 'subscription',
    productId: `oweme_${iapPlan}_monthly`,
    label: `${iapPlan.charAt(0).toUpperCase() + iapPlan.slice(1)} plan renewal (store)`,
    amount: 0,
    createdAt: ago(31, 10),
  };
  ops.push(
    prisma.billingTransaction.upsert({
      where: { id: iapTxnId },
      create: { id: iapTxnId, ...iapBinding },
      update: iapBinding,
    }),
  );
  push(
    'webhook:iap:error:1',
    'iap',
    'DID_RENEW',
    null,
    'error',
    {
      message: 'Error: entitlement write timed out while applying the renewal',
      businessId: iapTarget.id,
      payload: {
        platform: 'apple',
        productId: `oweme_${iapPlan}_monthly`,
        receipt: iapReceipt,
        notificationType: 'DID_RENEW',
      },
    },
    4,
  );

  await prisma.$transaction(ops);
}

async function seedAuditLog(
  admins: { superId: string; supportId: string },
  results: BusinessResult[],
): Promise<void> {
  const superAdmin = { id: admins.superId, name: ADMINS[0].name, role: 'superadmin' };
  const support = { id: admins.supportId, name: ADMINS[1].name, role: 'support' };
  const suspended = results.find((r) => r.spec.suspended)!;
  const banded = results.find((r) => (r.spec.enterpriseBands ?? 0) > 0)!;
  const overCeiling = results.find((r) => r.bvum > r.ceiling)!;
  const test = results.filter((r) => r.spec.isTest);

  const entries: {
    actor: { id: string; name: string; role: string };
    actionType: string;
    action: string;
    targetType?: string;
    targetId?: string;
    targetBusinessId?: string;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
    note?: string;
    days: number;
  }[] = [
    { actor: superAdmin, actionType: 'login', action: `${superAdmin.name} signed in`, days: 0 },
    { actor: support, actionType: 'login', action: `${support.name} signed in`, days: 1 },
    {
      actor: superAdmin,
      actionType: 'suspend',
      action: `${superAdmin.name} suspended ${suspended.spec.businessName}`,
      targetType: 'Business',
      targetId: suspended.id,
      targetBusinessId: suspended.id,
      before: { suspendedAt: null },
      after: { suspendedAt: ago(6, 14).toISOString() },
      note: 'Chargeback under investigation',
      days: 6,
    },
    {
      actor: superAdmin,
      actionType: 'enterprise-bands',
      action: `${superAdmin.name} set ${banded.spec.businessName} to 2 enterprise bands`,
      targetType: 'Business',
      targetId: banded.id,
      targetBusinessId: banded.id,
      before: { enterpriseBands: 0, bvumCeilingOverride: null },
      after: { enterpriseBands: 2, bvumCeilingOverride: String(banded.ceiling) },
      note: 'Signed contract, two additional 20M naira bands',
      days: 18,
    },
    {
      actor: superAdmin,
      actionType: 'force-plan',
      action: `${superAdmin.name} moved ${results[9].spec.businessName} to the business plan`,
      targetType: 'Business',
      targetId: results[9].id,
      targetBusinessId: results[9].id,
      before: { plan: 'market' },
      after: { plan: 'business' },
      note: 'Migrated from the legacy pricing sheet',
      days: 23,
    },
    {
      actor: support,
      actionType: 'grant-credits',
      action: `${support.name} granted 300 OweMe credits to ${results[5].spec.businessName}`,
      targetType: 'CreditLedger',
      targetId: results[5].id,
      targetBusinessId: results[5].id,
      before: { balance: Math.max(0, results[5].balance - 300) },
      after: { balance: results[5].balance },
      note: 'Goodwill after a failed reminder batch',
      days: 4,
    },
    {
      actor: support,
      actionType: 'retry-reminder',
      action: `${support.name} retried a failed reminder for ${results[6].spec.businessName}`,
      targetType: 'Reminder',
      targetId: fixedId(`${results[6].spec.key}:reminder:0:1`),
      targetBusinessId: results[6].id,
      before: { status: 'failed' },
      after: { status: 'scheduled' },
      days: 3,
    },
    {
      actor: superAdmin,
      actionType: 'reveal-otp',
      action: `${superAdmin.name} revealed the current OTP code for test business ${test[0].spec.businessName}`,
      targetType: 'Business',
      targetId: test[0].id,
      targetBusinessId: test[0].id,
      after: { phoneMasked: maskPhone(test[0].spec.phone), granted: true },
      days: 1,
    },
    {
      actor: support,
      actionType: 'reveal-otp',
      action: `${support.name} attempted an OTP reveal on a non-test business`,
      targetType: 'Business',
      targetId: results[2].id,
      targetBusinessId: results[2].id,
      after: { granted: false, reason: 'business-not-test-flagged' },
      days: 2,
    },
    {
      actor: superAdmin,
      actionType: 'test-flag',
      action: `${superAdmin.name} flagged ${test[1].spec.businessName} as a test account`,
      targetType: 'Business',
      targetId: test[1].id,
      targetBusinessId: test[1].id,
      before: { isTest: false },
      after: { isTest: true },
      days: 40,
    },
    {
      actor: superAdmin,
      actionType: 'reset-test-business',
      action: `${superAdmin.name} reset the demo data on ${test[0].spec.businessName}`,
      targetType: 'Business',
      targetId: test[0].id,
      targetBusinessId: test[0].id,
      note: 'Cleared before the investor walkthrough',
      days: 8,
    },
    {
      actor: superAdmin,
      actionType: 'replay-webhook',
      action: `${superAdmin.name} replayed paystack webhook event charge.success`,
      targetType: 'WebhookEventLog',
      targetId: fixedId('webhook:paystack:ok:0'),
      targetBusinessId: results[0].id,
      before: { outcome: 'error' },
      after: { outcome: 'ok', processed: true },
      days: 7,
    },
    {
      actor: superAdmin,
      actionType: 'create-admin',
      action: `${superAdmin.name} created the support admin ${support.name}`,
      targetType: 'AdminUser',
      targetId: support.id,
      after: { role: 'support', status: 'active' },
      days: 55,
    },
    {
      actor: superAdmin,
      actionType: 'change-password',
      action: `${support.name} changed their password`,
      targetType: 'AdminUser',
      targetId: support.id,
      days: 54,
    },
    {
      actor: superAdmin,
      actionType: 'revoke-admin',
      action: `${superAdmin.name} revoked every live session for ${support.name}`,
      targetType: 'AdminUser',
      targetId: support.id,
      after: { sessionsRevoked: 2 },
      note: 'Laptop reported lost, later recovered',
      days: 12,
    },
    {
      actor: support,
      actionType: 'login',
      action: `${support.name} reviewed the business over its BVUM ceiling: ${overCeiling.spec.businessName}`,
      targetType: 'Business',
      targetId: overCeiling.id,
      targetBusinessId: overCeiling.id,
      days: 2,
    },
  ];

  const ops: Prisma.PrismaPromise<unknown>[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const id = fixedId(`audit:${i}`);
    const data = {
      adminUserId: e.actor.id,
      adminNameSnapshot: e.actor.name,
      adminRoleSnapshot: e.actor.role,
      actionType: e.actionType,
      action: e.action,
      targetType: e.targetType ?? null,
      targetId: e.targetId ?? null,
      targetBusinessId: e.targetBusinessId ?? null,
      before: e.before ?? Prisma.JsonNull,
      after: e.after ?? Prisma.JsonNull,
      note: e.note ?? null,
      createdAt: ago(e.days, 9 + (i % 9)),
    };
    ops.push(prisma.adminAuditLog.upsert({ where: { id }, create: { id, ...data }, update: data }));
  }
  await prisma.$transaction(ops);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
async function printSummary(results: BusinessResult[]): Promise<void> {
  const counts: [string, number][] = [
    ['plans', await prisma.plan.count()],
    ['admin_users', await prisma.adminUser.count()],
    ['admin_audit_log', await prisma.adminAuditLog.count()],
    ['businesses', await prisma.business.count()],
    ['staff', await prisma.staff.count()],
    ['customers', await prisma.customer.count()],
    ['debts', await prisma.debt.count()],
    ['payments', await prisma.payment.count()],
    ['reminders', await prisma.reminder.count()],
    ['notifications', await prisma.notification.count()],
    ['notification_preferences', await prisma.notificationPreferences.count()],
    ['payout_accounts', await prisma.payoutAccount.count()],
    ['subscriptions', await prisma.subscription.count()],
    ['billing_transactions', await prisma.billingTransaction.count()],
    ['credit_ledgers', await prisma.creditLedger.count()],
    ['usage_events', await prisma.usageEvent.count()],
    ['otp_request_log', await prisma.otpRequestLog.count()],
    ['otp_test_codes', await prisma.otpTestCode.count()],
    ['webhook_event_log', await prisma.webhookEventLog.count()],
  ];

  const width = Math.max(...counts.map(([name]) => name.length));
  console.log('');
  console.log(`| ${'table'.padEnd(width)} | rows |`);
  console.log(`| ${'-'.repeat(width)} | ---- |`);
  for (const [name, count] of counts) {
    console.log(`| ${name.padEnd(width)} | ${String(count).padStart(4)} |`);
  }

  const over = results.filter((r) => r.bvum > r.ceiling);
  console.log('');
  console.log('BVUM vs effective ceiling (kobo):');
  for (const r of results) {
    const pct = r.ceiling > 0 ? ((r.bvum / r.ceiling) * 100).toFixed(1) : 'n/a';
    const flag = r.bvum > r.ceiling ? '  <-- OVER CEILING' : '';
    console.log(
      `  ${r.spec.businessName.padEnd(34)} ${r.spec.plan.padEnd(11)} ${String(r.bvum).padStart(12)} / ${String(r.ceiling).padStart(12)}  ${pct.padStart(6)}%${flag}`,
    );
  }
  console.log('');
  console.log(`Businesses over ceiling: ${over.length} (expected exactly 1)`);
  if (over.length !== 1) {
    throw new Error(`Calibration failed: ${over.length} businesses over ceiling, expected exactly 1`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const planRows = await prisma.plan.findMany();
  if (planRows.length === 0) {
    throw new Error('Plan catalog is empty. Run `npm run prisma:seed` (prisma/seed.ts) first.');
  }
  const plans = new Map<string, PlanRow>(
    planRows.map((p) => [
      p.id,
      {
        id: p.id,
        productId: p.productId,
        pricePerMonth: p.pricePerMonth,
        creditsPerMonth: p.creditsPerMonth,
        bvumCeiling: p.bvumCeiling,
      },
    ]),
  );

  const admins = await seedAdmins();
  console.log(`Admins: ${ADMINS.map((a) => `${a.email} (${a.role})`).join(', ')}`);

  const results: BusinessResult[] = [];
  for (const spec of BUSINESSES) {
    results.push(await seedBusiness(spec, plans));
  }
  console.log(`Businesses: ${results.length} seeded across ${new Set(results.map((r) => r.spec.plan)).size} plans`);

  await seedOtpLogs(results);
  const testCodes = await seedOtpTestCodes(results);
  console.log(`OTP test codes: ${testCodes} (test-flagged businesses only)`);
  await seedWebhookLog(results);
  await seedAuditLog(admins, results);

  await printSummary(results);

  const credits = results.map((r) => `${r.spec.businessName}: balance ${r.balance}, burned ${r.creditsBurnedThisPeriod}`);
  console.log('');
  console.log('Credit ledgers this period (balance = grant + bundles - burned):');
  for (const line of credits) console.log(`  ${line}`);
  console.log('');
  console.log('Admin demo seed complete. Re-running is safe (fixed ids, upsert-only).');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
