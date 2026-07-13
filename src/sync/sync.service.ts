import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  Customer,
  Debt,
  Payment,
  Reminder,
  ReminderChannel,
  ReminderStatus,
  SyncQueryDto,
  SyncResponse,
  SyncStatusResponse,
} from '../shared';

// --- raw Prisma row shapes (only the columns the serializers read) ---------
type CustomerRow = {
  id: string;
  businessId: string;
  name: string;
  phone: string;
  address: string | null;
  note: string | null;
  deleted: boolean;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

type DebtRow = {
  id: string;
  businessId: string;
  customerId: string;
  amount: number;
  note: string | null;
  dueDate: Date | null;
  createdAt: Date;
  lastReminderAt: Date | null;
  nextReminderAt: Date | null;
  deleted: boolean;
  updatedAt: Date;
  version: number;
};

type PaymentRow = {
  id: string;
  businessId: string;
  debtId: string;
  amount: number;
  method: string;
  reference: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

type ReminderRow = {
  id: string;
  businessId: string;
  debtId: string;
  channel: string;
  status: string;
  message: string | null;
  scheduledFor: Date | null;
  sentAt: Date | null;
  payLinkUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

/**
 * Sync service — the offline-first delta-pull engine (conventions §Offline-first sync protocol).
 * Owns NO table of its own; reads the four synced entity tables (Customer/Debt/Payment/Reminder)
 * via PrismaService, always scoped to the JWT businessId (tenancy — cross-tenant reads impossible).
 *
 * Delta model:
 *   - `changes` = live rows in each synced entity whose updatedAt > since (or ALL when since absent).
 *     Soft-deleted debts (deleted=true) are EXCLUDED from changes — they surface only as tombstones.
 *   - `tombstones` = soft-deleted rows the client should drop locally. Customer and Debt both carry
 *     a `deleted` flag; tombstones.customers / tombstones.debts carry those ids (updatedAt > since).
 *   - `cursor` = the max updatedAt observed across changes+tombstones (ISO string), so the next pull
 *     asks for strictly-newer rows. When nothing was observed the previous cursor (or server now)
 *     is echoed back so the watermark never regresses.
 *
 * KNOWN v1 LIMITATION — tombstone coverage:
 *   Payment / Reminder have NO soft-delete/tombstone source in the v1 schema (only Customer and Debt
 *   carry a `deleted` flag). Their tombstone arrays are therefore ALWAYS empty. When those entities
 *   gain deletes, populate the arrays the same way as customers/debts.
 */
@Injectable()
export class SyncService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /sync?since=<cursor> — delta pull across the four synced entities for this tenant.
   * `since` is an ISO/epoch cursor; invalid or absent -> full pull (all rows).
   */
  async pull(businessId: string, query: SyncQueryDto): Promise<SyncResponse> {
    const since = parseCursor(query.since);
    // updatedAt > since when we have a valid cursor; otherwise no time bound (full pull).
    const changedSince = since ? { updatedAt: { gt: since } } : {};

    const [customers, deletedCustomers, liveDebts, deletedDebts, payments, reminders] = await Promise.all([
      this.prisma.customer.findMany({ where: { businessId, deleted: false, ...changedSince } }),
      this.prisma.customer.findMany({ where: { businessId, deleted: true, ...changedSince } }),
      this.prisma.debt.findMany({ where: { businessId, deleted: false, ...changedSince } }),
      this.prisma.debt.findMany({ where: { businessId, deleted: true, ...changedSince } }),
      this.prisma.payment.findMany({ where: { businessId, ...changedSince } }),
      this.prisma.reminder.findMany({ where: { businessId, ...changedSince } }),
    ]);

    const customerRows = customers as unknown as CustomerRow[];
    const deletedCustomerRows = deletedCustomers as unknown as CustomerRow[];
    const liveDebtRows = liveDebts as unknown as DebtRow[];
    const deletedDebtRows = deletedDebts as unknown as DebtRow[];
    const paymentRows = payments as unknown as PaymentRow[];
    const reminderRows = reminders as unknown as ReminderRow[];

    // New cursor = latest updatedAt seen across everything (live + tombstoned). Falls back to the
    // caller's cursor (or server now) when the tenant had no matching rows, so it never regresses.
    const watermark = maxUpdatedAt([
      ...customerRows,
      ...deletedCustomerRows,
      ...liveDebtRows,
      ...deletedDebtRows,
      ...paymentRows,
      ...reminderRows,
    ]);
    const cursor = (watermark ?? since ?? new Date()).toISOString();

    return {
      changes: {
        customers: customerRows.map(serializeCustomer),
        debts: liveDebtRows.map(serializeDebt),
        payments: paymentRows.map(serializePayment),
        reminders: reminderRows.map(serializeReminder),
      },
      tombstones: {
        // Customer and Debt carry a soft-delete flag; Payment/Reminder have none (see class doc).
        customers: deletedCustomerRows.map((c) => c.id),
        debts: deletedDebtRows.map((d) => d.id),
        payments: [],
        reminders: [],
      },
      cursor,
    };
  }

  /**
   * GET /sync/status — backs the Backup screen.
   *   - lastSyncedAt = the server watermark (latest updatedAt across the tenant's synced rows),
   *     or null when the tenant has no synced data yet.
   *   - pendingCount = 0: pending writes are a CLIENT-side concept (the device tracks its own
   *     un-synced queue); the server has nothing pending on its side.
   */
  async status(businessId: string): Promise<SyncStatusResponse> {
    const [customer, debt, payment, reminder] = await Promise.all([
      this.prisma.customer.findFirst({ where: { businessId }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
      this.prisma.debt.findFirst({ where: { businessId }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
      this.prisma.payment.findFirst({ where: { businessId }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
      this.prisma.reminder.findFirst({ where: { businessId }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
    ]);

    const watermark = maxUpdatedAt(
      [customer, debt, payment, reminder].filter((r): r is { updatedAt: Date } => r !== null),
    );

    return {
      lastSyncedAt: watermark ? watermark.toISOString() : null,
      pendingCount: 0,
    };
  }
}

// --- helpers ---------------------------------------------------------------

/** Parse a `since` cursor (ISO string or epoch millis) into a Date; invalid/absent -> null (full pull). */
function parseCursor(since: string | undefined): Date | null {
  if (!since) return null;
  const asNumber = Number(since);
  const d = Number.isFinite(asNumber) && since.trim() !== '' && /^\d+$/.test(since.trim())
    ? new Date(asNumber)
    : new Date(since);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Latest updatedAt across a set of rows, or null when the set is empty. */
function maxUpdatedAt(rows: { updatedAt: Date }[]): Date | null {
  let max: Date | null = null;
  for (const r of rows) {
    if (max === null || r.updatedAt.getTime() > max.getTime()) max = r.updatedAt;
  }
  return max;
}

function serializeCustomer(r: CustomerRow): Customer {
  return {
    id: r.id,
    businessId: r.businessId,
    name: r.name,
    phone: r.phone,
    address: r.address,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    version: r.version,
  };
}

function serializeDebt(r: DebtRow): Debt {
  return {
    id: r.id,
    businessId: r.businessId,
    customerId: r.customerId,
    amount: r.amount,
    note: r.note,
    dueDate: r.dueDate ? r.dueDate.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    lastReminderAt: r.lastReminderAt ? r.lastReminderAt.toISOString() : null,
    nextReminderAt: r.nextReminderAt ? r.nextReminderAt.toISOString() : null,
    deleted: r.deleted,
    updatedAt: r.updatedAt.toISOString(),
    version: r.version,
  };
}

function serializePayment(r: PaymentRow): Payment {
  return {
    id: r.id,
    businessId: r.businessId,
    debtId: r.debtId,
    amount: r.amount,
    method: r.method,
    reference: r.reference,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    version: r.version,
  };
}

function serializeReminder(r: ReminderRow): Reminder {
  return {
    id: r.id,
    businessId: r.businessId,
    debtId: r.debtId,
    channel: r.channel as ReminderChannel,
    status: r.status as ReminderStatus,
    message: r.message,
    scheduledFor: r.scheduledFor ? r.scheduledFor.toISOString() : null,
    sentAt: r.sentAt ? r.sentAt.toISOString() : null,
    payLinkUrl: r.payLinkUrl,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    version: r.version,
  };
}
