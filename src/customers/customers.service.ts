import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ActivityItem,
  CreateCustomerDto,
  Customer,
  CustomerView,
  DebtStatus,
  ListCustomersQueryDto,
  PAGINATION_DEFAULT_LIMIT,
  Paginated,
} from '../shared';
import { clampKobo, ForbiddenAppException, NotFoundAppException } from '../common';

type DebtRow = {
  id: string;
  customerId: string;
  amount: number;
  note: string | null;
  dueDate: Date | null;
  createdAt: Date;
  lastReminderAt: Date | null;
  deleted: boolean;
};

type PaymentRow = { debtId: string; amount: number; method: string; reference: string; createdAt: Date };
type ReminderRow = { debtId: string; channel: string; sentAt: Date | null };

/** Open-debt status severity (worst first). worstStatus picks the max; 'paid' when none open. */
const STATUS_SEVERITY: Record<string, number> = {
  overdue: 5,
  partial: 4,
  reminder: 3,
  scheduled: 2,
  outstanding: 1,
  paid: 0,
};

/**
 * Customers service. Tenant-scoped by the JWT businessId. Roster roles owner|staff;
 * DELETE is owner-only (enforced in the controller via @Roles).
 *
 * CustomerView aggregates are computed from the debt/payment/reminder TABLES (those
 * MODULES ship in later waves; this service only reads the tables via Prisma):
 *   owed        = sum(remaining) over non-archived debts, remaining=clamp(amount-sum(payments))
 *   debtCount   = open debts (remaining>0)
 *   worstStatus = highest-severity open-debt status; 'paid' when none open
 *   lastActivityAt/lastPaymentAt/lastReminderAt/earliestOverdueDue derived from payments/reminders/debts.
 */
@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /customers — server-side filter/sort/search + cursor pagination over computed views. */
  async list(businessId: string, query: ListCustomersQueryDto): Promise<Paginated<CustomerView>> {
    const views = await this.buildViews(businessId);

    // --- search (traditional: name substring OR phone digits substring; never AI) ---
    let filtered = views;
    const q = query.q?.trim();
    if (q) {
      const needle = q.toLowerCase();
      const digits = q.replace(/\D/g, '');
      filtered = filtered.filter((v) => {
        const nameHit = v.name.toLowerCase().includes(needle);
        const phoneHit = digits.length > 0 && v.phone.replace(/\D/g, '').includes(digits);
        return nameHit || phoneHit;
      });
    }

    // --- filter ---
    switch (query.filter) {
      case 'owing':
        filtered = filtered.filter((v) => v.owed > 0);
        break;
      case 'overdue':
        filtered = filtered.filter((v) => v.earliestOverdueDue !== null);
        break;
      case 'paid-up':
        filtered = filtered.filter((v) => v.debtCount === 0);
        break;
      case 'all':
      default:
        break;
    }

    // --- sort ---
    const sort = query.sort ?? 'name';
    filtered = [...filtered].sort((a, b) => {
      switch (sort) {
        case 'most-owed':
          if (b.owed !== a.owed) return b.owed - a.owed;
          return a.name.localeCompare(b.name);
        case 'recently-active': {
          const at = a.lastActivityAt ? Date.parse(a.lastActivityAt) : -Infinity;
          const bt = b.lastActivityAt ? Date.parse(b.lastActivityAt) : -Infinity;
          if (bt !== at) return bt - at;
          return a.name.localeCompare(b.name);
        }
        case 'name':
        default:
          return a.name.localeCompare(b.name);
      }
    });

    // --- cursor pagination (opaque offset over the deterministic sorted list) ---
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;
    const offset = decodeCursor(query.cursor);
    const page = filtered.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    const nextCursor = nextOffset < filtered.length ? encodeCursor(nextOffset) : null;
    return { data: page, nextCursor };
  }

  /** GET /customers/:id — single CustomerView. 404 if not in tenant (or soft-deleted). */
  async getOne(businessId: string, id: string): Promise<CustomerView> {
    const customer = await this.prisma.customer.findFirst({ where: { id, businessId, deleted: false } });
    if (!customer) throw new NotFoundAppException('Customer not found');
    const views = await this.buildViews(businessId, [customer.id]);
    return views[0];
  }

  /**
   * POST /customers — idempotent on client-minted id. A re-seen id returns the existing
   * row (the controller renders it 200); a new id creates the row (201).
   */
  async create(
    businessId: string,
    dto: CreateCustomerDto,
  ): Promise<{ customer: Customer; created: boolean }> {
    const existing = await this.prisma.customer.findUnique({ where: { id: dto.id } });
    if (existing) {
      if (existing.businessId !== businessId) {
        // id collision across tenants — treat as forbidden rather than leak another tenant's row.
        throw new ForbiddenAppException('Customer id already exists in another business');
      }
      return { customer: existing as unknown as Customer, created: false };
    }
    const created = await this.prisma.customer.create({
      data: {
        id: dto.id,
        businessId,
        name: dto.name,
        phone: dto.phone,
        note: dto.note ?? null,
        address: dto.address ?? null,
      },
    });
    return { customer: created as unknown as Customer, created: true };
  }

  /**
   * DELETE /customers/:id — owner-only (role gate in controller). Soft-deletes the
   * customer (deleted=true, version bumped) AND soft-archives its debts (deleted=true)
   * in one transaction, returning the now-deleted Customer row. The delete surfaces to
   * clients as a sync tombstone (tombstones.customers); debts are archived, not dropped.
   */
  async remove(businessId: string, id: string): Promise<Customer> {
    const customer = await this.prisma.customer.findFirst({ where: { id, businessId, deleted: false } });
    if (!customer) throw new NotFoundAppException('Customer not found');

    const [, , deleted] = await this.prisma.$transaction([
      this.prisma.debt.updateMany({
        where: { businessId, customerId: id, deleted: false },
        data: { deleted: true, version: { increment: 1 } },
      }),
      this.prisma.customer.update({
        where: { id },
        data: { deleted: true, version: { increment: 1 } },
      }),
      this.prisma.customer.findFirstOrThrow({ where: { id, businessId } }),
    ]);
    return deleted as unknown as Customer;
  }

  /** GET /customers/:id/activity — merged payments+debts+sent-reminders timeline, at desc. */
  async activity(businessId: string, id: string): Promise<ActivityItem[]> {
    const customer = await this.prisma.customer.findFirst({ where: { id, businessId, deleted: false } });
    if (!customer) throw new NotFoundAppException('Customer not found');

    const debts = (await this.prisma.debt.findMany({
      where: { businessId, customerId: id },
    })) as unknown as DebtRow[];
    const debtIds = debts.map((d) => d.id);
    const [payments, reminders] = await Promise.all([
      this.prisma.payment.findMany({ where: { businessId, debtId: { in: debtIds } } }),
      this.prisma.reminder.findMany({ where: { businessId, debtId: { in: debtIds } } }),
    ]);

    const items: ActivityItem[] = [];
    for (const d of debts) {
      items.push({
        kind: 'debt',
        title: 'Debt recorded',
        subtitle: d.note ?? '',
        amount: d.amount,
        at: d.createdAt.toISOString(),
      });
    }
    for (const p of payments as unknown as PaymentRow[]) {
      items.push({
        kind: 'payment',
        title: 'Payment received',
        subtitle: `${p.method} · ${p.reference}`,
        amount: p.amount,
        at: p.createdAt.toISOString(),
      });
    }
    for (const r of reminders as unknown as ReminderRow[]) {
      if (!r.sentAt) continue; // only SENT reminders appear in the timeline
      items.push({
        kind: 'reminder',
        title: 'Reminder sent',
        subtitle: r.channel,
        amount: null,
        at: r.sentAt.toISOString(),
      });
    }
    items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return items;
  }

  // --- aggregate computation -----------------------------------------------

  /**
   * Build CustomerView[] for the tenant (optionally restricted to specific customer ids),
   * computing per-customer aggregates from the debt/payment/reminder tables in memory.
   */
  private async buildViews(businessId: string, onlyIds?: string[]): Promise<CustomerView[]> {
    const customerWhere = onlyIds
      ? { businessId, deleted: false, id: { in: onlyIds } }
      : { businessId, deleted: false };
    const [customers, debts] = await Promise.all([
      this.prisma.customer.findMany({ where: customerWhere }),
      this.prisma.debt.findMany({ where: { businessId } }),
    ]);
    const debtIds = debts.map((d) => d.id);
    const [payments, reminders] = await Promise.all([
      this.prisma.payment.findMany({ where: { businessId, debtId: { in: debtIds } } }),
      this.prisma.reminder.findMany({ where: { businessId, debtId: { in: debtIds } } }),
    ]);

    // paid per debt + debt->customer map
    const paidByDebt = new Map<string, number>();
    for (const p of payments as unknown as PaymentRow[]) {
      paidByDebt.set(p.debtId, (paidByDebt.get(p.debtId) ?? 0) + p.amount);
    }
    const customerByDebt = new Map<string, string>();
    const debtsByCustomer = new Map<string, DebtRow[]>();
    for (const d of debts as unknown as DebtRow[]) {
      customerByDebt.set(d.id, d.customerId);
      const arr = debtsByCustomer.get(d.customerId) ?? [];
      arr.push(d);
      debtsByCustomer.set(d.customerId, arr);
    }

    // last payment / last reminder per customer (via debt->customer)
    const lastPaymentAt = new Map<string, number>();
    for (const p of payments as unknown as PaymentRow[]) {
      const cid = customerByDebt.get(p.debtId);
      if (!cid) continue;
      const t = p.createdAt.getTime();
      if (t > (lastPaymentAt.get(cid) ?? -Infinity)) lastPaymentAt.set(cid, t);
    }
    const lastReminderAt = new Map<string, number>();
    for (const r of reminders as unknown as ReminderRow[]) {
      if (!r.sentAt) continue;
      const cid = customerByDebt.get(r.debtId);
      if (!cid) continue;
      const t = r.sentAt.getTime();
      if (t > (lastReminderAt.get(cid) ?? -Infinity)) lastReminderAt.set(cid, t);
    }

    const now = Date.now();
    return customers.map((c) => {
      const cid = c.id;
      const custDebts = debtsByCustomer.get(cid) ?? [];

      let owed = 0;
      let debtCount = 0;
      let worstSev = -1;
      let worstStatus: DebtStatus = 'paid';
      let earliestOverdue: number | null = null;
      let lastDebtAt = -Infinity;

      for (const d of custDebts) {
        lastDebtAt = Math.max(lastDebtAt, d.createdAt.getTime());
        if (d.deleted) continue; // owed/status computed over NON-archived debts only

        const paid = paidByDebt.get(d.id) ?? 0;
        const remaining = clampKobo(d.amount - paid);
        owed += remaining;
        if (remaining <= 0) continue; // closed debt — not open

        debtCount += 1;
        const due = d.dueDate ? d.dueDate.getTime() : null;
        const status = deriveOpenStatus(due, now, paid, d.lastReminderAt);
        if (status === 'overdue' && due !== null) {
          earliestOverdue = earliestOverdue === null ? due : Math.min(earliestOverdue, due);
        }
        const sev = STATUS_SEVERITY[status] ?? 0;
        if (sev > worstSev) {
          worstSev = sev;
          worstStatus = status;
        }
      }

      const lp = lastPaymentAt.get(cid) ?? null;
      const lr = lastReminderAt.get(cid) ?? null;
      const activityTimes = [lp, lr, lastDebtAt === -Infinity ? null : lastDebtAt].filter(
        (t): t is number => t !== null,
      );
      const la = activityTimes.length ? Math.max(...activityTimes) : null;

      const view: CustomerView = {
        ...(c as unknown as Customer),
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
        owed,
        debtCount,
        worstStatus,
        lastActivityAt: la !== null ? new Date(la).toISOString() : null,
        lastPaymentAt: lp !== null ? new Date(lp).toISOString() : null,
        lastReminderAt: lr !== null ? new Date(lr).toISOString() : null,
        earliestOverdueDue: earliestOverdue !== null ? new Date(earliestOverdue).toISOString() : null,
      };
      return view;
    });
  }
}

/** Derive an OPEN debt's status (remaining>0) for the worstStatus aggregate. */
function deriveOpenStatus(
  due: number | null,
  now: number,
  paid: number,
  lastReminderAt: Date | null,
): DebtStatus {
  if (due !== null && due < now) return 'overdue';
  if (paid > 0) return 'partial';
  if (lastReminderAt) return 'reminder';
  if (due !== null && due >= now) return 'scheduled';
  return 'outstanding';
}

/** Opaque cursor = base64(offset). */
function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const o = Number(parsed?.o);
    return Number.isInteger(o) && o >= 0 ? o : 0;
  } catch {
    return 0;
  }
}
