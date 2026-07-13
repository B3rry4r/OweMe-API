/**
 * Entity + view/response interfaces — the single source of truth for every
 * registry resource shape. Build agents import these; they never re-declare a shape.
 * Money fields are integer kobo (S-1). ids are UUIDv7 strings (S-2). Dates are ISO strings on the wire.
 */
import {
  Role,
  ReminderTone,
  PlanId,
  DebtStatus,
  ReminderChannel,
  ReminderStatus,
  NotificationKind,
  EntitlementState,
  BillingKind,
  ActivityKind,
} from './enums';

// --- Auth / tenant ---------------------------------------------------------
export interface Business {
  id: string;
  businessName: string;
  ownerName: string;
  phone: string;
  category: string;
  currency: string; // '<code> (<symbol>)'
  reminderTone: ReminderTone;
  plan: PlanId;
  paystackSubaccount: string | null;
  logoUrl: string | null;
  branchId: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface Staff {
  id: string;
  businessId: string;
  name: string;
  phone: string;
  role: Role;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** GET /staff also returns seat usage derived from plan. */
export interface StaffListResponse {
  data: Staff[];
  seatCap: number; // -1 = unlimited
  seatsUsed: number;
}

/** POST /auth/verify-otp success. */
export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  user: Staff;
  business: Business | null;
}

/** GET /me. */
export interface MeResponse {
  user: Staff;
  business: Business | null;
}

// --- Customers -------------------------------------------------------------
export interface Customer {
  id: string;
  businessId: string;
  name: string;
  phone: string;
  address: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** Customer + computed aggregates (roster + detail). */
export interface CustomerView extends Customer {
  owed: number; // kobo — sum(remaining) over non-archived debts
  debtCount: number; // open debts (remaining>0)
  worstStatus: DebtStatus; // highest-severity open status; 'paid' when none open
  lastActivityAt: string | null;
  lastPaymentAt: string | null;
  lastReminderAt: string | null;
  earliestOverdueDue: string | null;
}

export interface CustomerRisk {
  customerId: string;
  score: number;
  band: string;
}

// --- Debts -----------------------------------------------------------------
export interface Debt {
  id: string;
  businessId: string;
  customerId: string;
  amount: number; // kobo (principal)
  note: string | null;
  dueDate: string | null;
  createdAt: string;
  lastReminderAt: string | null;
  nextReminderAt: string | null;
  deleted: boolean;
  updatedAt: string;
  version: number;
}

/** Debt + derived money/status + embedded customer stub. */
export interface DebtView extends Debt {
  paidAmount: number; // kobo — sum(payments.amount)
  remaining: number; // kobo — clamp(amount - paidAmount)
  status: DebtStatus; // DERIVED, never stored
  customer: { id: string; name: string; phone: string };
}

export interface PayLink {
  url: string;
}

export interface ReminderScheduleStep {
  offsetLabel: '3 days before due' | 'On due date' | '3 days overdue' | 'Final follow-up';
  date: string;
  status: 'sent' | 'pending';
}

// --- Payments --------------------------------------------------------------
export interface Payment {
  id: string;
  businessId: string;
  debtId: string;
  amount: number; // kobo
  method: string; // recorded verbatim
  reference: string; // server-minted receipt number
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** GET /payments/:id — receipt fetch. */
export interface ReceiptResponse {
  payment: Payment;
  debt: DebtView;
  business: { businessName: string };
}

// --- Reminders -------------------------------------------------------------
export interface Reminder {
  id: string;
  businessId: string;
  debtId: string;
  channel: ReminderChannel;
  status: ReminderStatus;
  message: string | null;
  scheduledFor: string | null;
  sentAt: string | null;
  payLinkUrl: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** GET /reminders list item — reminder joined with debt+customer. */
export interface ReminderListItem extends Reminder {
  debt: { id: string; amount: number };
  customer: { id: string; name: string; phone: string };
}

// --- Notifications ---------------------------------------------------------
export interface Notification {
  id: string;
  businessId: string;
  title: string;
  body: string;
  kind: NotificationKind;
  read: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface NotificationPreferences {
  businessId: string;
  payments: boolean;
  overdue: boolean;
  delivery: boolean;
  weekly: boolean;
  updatedAt: string;
  version: number;
}

// --- Dashboard / activity --------------------------------------------------
export interface DashboardResponse {
  outstandingTotal: number; // kobo
  owingCustomerCount: number;
  recoveredThisMonth: number; // kobo
  dueTodayTotal: number; // kobo
  overdueTotal: number; // kobo
  overdueCount: number;
  activity: ActivityItem[]; // cap 8
  hasAnyDebts: boolean;
  hasAnyCustomers: boolean;
  hasUnread: boolean;
}

export interface ActivityItem {
  kind: ActivityKind;
  title: string;
  subtitle: string;
  amount: number | null; // kobo
  at: string;
}

// --- Payout account (Paystack) ---------------------------------------------
export interface PayoutAccount {
  businessId: string;
  bankCode: string;
  accountNumber: string;
  accountName: string;
}

export interface Bank {
  code: string;
  name: string;
}

// --- Plans / billing / ledgers ---------------------------------------------
export interface PlanLimits {
  sendsPerMonth: number; // -1 fair-use
  aiCreditsPerMonth: number; // -1 fair-use
  staffSeats: number; // -1 unlimited
  bvumCeiling: number | null; // kobo, null unlimited
}

export interface Plan {
  id: PlanId;
  name: string;
  pricePerMonth: number; // kobo, 0 = free
  tagline: string;
  features: string[];
  productId: string | null;
  talkToSales: boolean;
  recommended: boolean;
  limits: PlanLimits;
}

export interface Subscription {
  businessId: string;
  planId: PlanId;
  entitlementState: EntitlementState;
  activePlanId: PlanId;
  renewalAt: string | null;
}

export interface BillingTransaction {
  id: string;
  businessId: string;
  kind: BillingKind;
  productId: string;
  label: string;
  amount: number; // kobo
  createdAt: string;
}

export interface MeterView {
  used: number;
  remaining?: number;
  balance?: number;
  monthlyGrant: number;
  periodStart: string;
}

export interface UsageResponse {
  sendAllowance: { used: number; remaining: number; monthlyGrant: number; periodStart: string };
  aiCredits: { used: number; balance: number; monthlyGrant: number; periodStart: string };
}

// --- BVUM ------------------------------------------------------------------
export interface BvumResponse {
  value: number; // kobo
  ceiling: number | null; // kobo
  recommendedPlan: PlanId | null;
  windowDays: 30;
}

// --- Voice / insights ------------------------------------------------------
export interface VoiceParseResponse {
  customerName: string | null;
  amount: number; // kobo
  description: string | null;
  dueDate: string | null;
}

// --- Sync ------------------------------------------------------------------
export interface SyncResponse {
  changes: {
    customers: Customer[];
    debts: Debt[];
    payments: Payment[];
    reminders: Reminder[];
  };
  tombstones: {
    customers: string[];
    debts: string[];
    payments: string[];
    reminders: string[];
  };
  cursor: string;
}

export interface SyncStatusResponse {
  lastSyncedAt: string | null;
  pendingCount: number;
}
