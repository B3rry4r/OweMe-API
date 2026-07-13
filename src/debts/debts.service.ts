import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateDebtDto,
  DebtStatus,
  DebtView,
  ListDebtsQueryDto,
  PAGINATION_DEFAULT_LIMIT,
  Paginated,
  PayLink,
  Payment,
  Reminder,
  ReminderScheduleStep,
  UpdateDebtDto,
} from '../shared';
import {
  assertVersion,
  clampKobo,
  ForbiddenAppException,
  NotFoundAppException,
  PAYSTACK_GATEWAY,
  PaystackGateway,
  uuidv7,
} from '../common';
import { BvumService } from '../bvum/bvum.service';
import { owemeCommissionKobo, combinedPayLinkFeeKobo } from './pay-link-fees';

type CustomerStub = { id: string; name: string; phone: string };
// (schedule offsets computed via UTC date arithmetic; see reminderSchedule)

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
  customer: CustomerStub;
};

/**
 * Debts service. Tenant-scoped by the JWT businessId. Roles owner|staff; DELETE is
 * owner-only (enforced in the controller via @Roles).
 *
 * DebtView derives money + status from the payment TABLE (the Payment MODULE ships in a
 * later wave; this service only reads its table via Prisma):
 *   paidAmount = sum(payments.amount)
 *   remaining  = clamp(amount - paidAmount)
 *   status     = DERIVED server-side (paid|overdue|partial|reminder|scheduled|outstanding)
 * The reminder SCHEDULE is DERIVED from dueDate (see reminderSchedule) — no Reminder rows
 * are materialized here and the Reminder module is never imported.
 */
@Injectable()
export class DebtsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYSTACK_GATEWAY) private readonly paystack: PaystackGateway,
    private readonly bvum: BvumService,
  ) {}

  /** GET /debts — server-side status/sort/q filter + cursor pagination over derived views. */
  async list(businessId: string, query: ListDebtsQueryDto): Promise<Paginated<DebtView>> {
    const archived = query.status === 'archived';
    const rows = (await this.prisma.debt.findMany({
      where: { businessId, deleted: archived ? true : false },
      include: { customer: { select: { id: true, name: true, phone: true } } },
    })) as unknown as DebtRow[];

    const paidByDebt = await this.paidByDebt(businessId, rows.map((r) => r.id));
    let views = rows.map((r) => this.toView(r, paidByDebt.get(r.id) ?? 0));

    // --- status filter (archived already narrowed at the DB level) ---
    switch (query.status) {
      case 'overdue':
        views = views.filter((v) => v.status === 'overdue');
        break;
      case 'paid':
        views = views.filter((v) => v.remaining <= 0);
        break;
      case 'active':
        views = views.filter((v) => v.remaining > 0);
        break;
      case 'archived':
      default:
        break;
    }

    // --- search (traditional: customer name substring OR phone digits OR note; never AI) ---
    const q = query.q?.trim();
    if (q) {
      const needle = q.toLowerCase();
      const digits = q.replace(/\D/g, '');
      views = views.filter((v) => {
        const nameHit = v.customer.name.toLowerCase().includes(needle);
        const phoneHit = digits.length > 0 && v.customer.phone.replace(/\D/g, '').includes(digits);
        const noteHit = (v.note ?? '').toLowerCase().includes(needle);
        return nameHit || phoneHit || noteHit;
      });
    }

    // --- sort ---
    const sort = query.sort ?? 'recently-added';
    views = [...views].sort((a, b) => {
      switch (sort) {
        case 'most-owed':
          if (b.remaining !== a.remaining) return b.remaining - a.remaining;
          return Date.parse(b.createdAt) - Date.parse(a.createdAt);
        case 'soonest-due': {
          const at = a.dueDate ? Date.parse(a.dueDate) : Infinity; // nulls last
          const bt = b.dueDate ? Date.parse(b.dueDate) : Infinity;
          if (at !== bt) return at - bt;
          return Date.parse(b.createdAt) - Date.parse(a.createdAt);
        }
        case 'recently-added':
        default:
          return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      }
    });

    // --- cursor pagination (opaque offset over the deterministic sorted list) ---
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;
    const offset = decodeCursor(query.cursor);
    const page = views.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    const nextCursor = nextOffset < views.length ? encodeCursor(nextOffset) : null;
    return { data: page, nextCursor };
  }

  /** GET /debts/:id — single DebtView. 404 if not in tenant. */
  async getOne(businessId: string, id: string): Promise<DebtView> {
    const row = await this.findRow(businessId, id);
    const paid = await this.paidFor(businessId, id);
    return this.toView(row, paid);
  }

  /**
   * POST /debts — idempotent on client-minted id. A re-seen id returns the existing view
   * (controller renders it 200); a new id creates the row (201). customerId must belong to
   * the tenant. The reminder schedule is DERIVED from dueDate (no rows materialized here).
   */
  async create(
    businessId: string,
    dto: CreateDebtDto,
  ): Promise<{ view: DebtView; created: boolean }> {
    const existing = await this.prisma.debt.findUnique({ where: { id: dto.id } });
    if (existing) {
      if (existing.businessId !== businessId) {
        throw new ForbiddenAppException('Debt id already exists in another business');
      }
      return { view: await this.getOne(businessId, existing.id), created: false };
    }

    const customer = await this.prisma.customer.findFirst({
      where: { id: dto.customerId, businessId },
    });
    if (!customer) throw new NotFoundAppException('Customer not found in this business');

    // Rev 2: INSTANT BVUM enforcement — reject a new debt that would breach the plan's
    // ceiling (403 BVUM_CEILING). Only NEW debts are gated; the idempotent re-POST above
    // returns before here, and updates/payments/reminders are never blocked.
    await this.bvum.assertDebtWithinCeiling(businessId, dto.amount, dto.customerId);

    const created = await this.prisma.debt.create({
      data: {
        id: dto.id,
        businessId,
        customerId: dto.customerId,
        amount: dto.amount,
        note: dto.note ?? null,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
      },
    });
    return { view: await this.getOne(businessId, created.id), created: true };
  }

  /** PATCH /debts/:id — If-Match version; clearDueDate=true explicitly nulls dueDate. */
  async update(
    businessId: string,
    id: string,
    dto: UpdateDebtDto,
    expectedVersion: number | null,
  ): Promise<DebtView> {
    const row = await this.findRow(businessId, id);
    assertVersion(expectedVersion, row);

    const dueDate =
      dto.clearDueDate === true
        ? null
        : dto.dueDate !== undefined
          ? new Date(dto.dueDate)
          : undefined;

    await this.prisma.debt.update({
      where: { id },
      data: {
        ...(dto.amount !== undefined ? { amount: dto.amount } : {}),
        ...(dto.note !== undefined ? { note: dto.note } : {}),
        ...(dueDate !== undefined ? { dueDate } : {}),
        version: { increment: 1 },
      },
    });
    return this.getOne(businessId, id);
  }

  /** DELETE /debts/:id — owner-only (role gate in controller). Soft delete (deleted=true). */
  async remove(businessId: string, id: string): Promise<DebtView> {
    const row = await this.findRow(businessId, id);
    if (!row.deleted) {
      await this.prisma.debt.update({
        where: { id },
        data: { deleted: true, version: { increment: 1 } },
      });
    }
    return this.getOne(businessId, id);
  }

  /** POST /debts/:id/restore — un-archive (deleted=false). */
  async restore(businessId: string, id: string): Promise<DebtView> {
    const row = await this.findRow(businessId, id);
    if (row.deleted) {
      await this.prisma.debt.update({
        where: { id },
        data: { deleted: false, version: { increment: 1 } },
      });
    }
    return this.getOne(businessId, id);
  }

  /**
   * POST /debts/:id/pay-link — creates a Paystack payment request against the business
   * subaccount for the outstanding balance and returns the checkout url.
   */
  async payLink(businessId: string, id: string): Promise<PayLink> {
    const row = await this.findRow(businessId, id);
    const paid = await this.paidFor(businessId, id);
    const remaining = clampKobo(row.amount - paid);
    const amount = remaining > 0 ? remaining : row.amount;
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });

    const result = await this.paystack.createPaymentRequest({
      amount,
      reference: `PAYL_${uuidv7()}`,
      subaccountCode: business?.paystackSubaccount ?? null,
      // Rev 2: OweMe's 1% (cap ₦500) commission is taken via the subaccount split.
      transactionCharge: owemeCommissionKobo(amount),
      metadata: { debtId: id, businessId, customerId: row.customerId },
    });
    // Disclose ONE combined fee (2.5% + ₦100, cap ₦2,500) — never the breakdown.
    return { url: result.url, fee: combinedPayLinkFeeKobo(amount) };
  }

  /** GET /debts/:id/payments — the debt's payments, newest-first. */
  async payments(businessId: string, id: string): Promise<Payment[]> {
    await this.findRow(businessId, id);
    const rows = await this.prisma.payment.findMany({
      where: { businessId, debtId: id },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((p) => serializePayment(p as unknown as PaymentRow));
  }

  /** GET /debts/:id/reminders — the debt's reminder history timeline, newest-first. */
  async reminders(businessId: string, id: string): Promise<Reminder[]> {
    await this.findRow(businessId, id);
    const rows = await this.prisma.reminder.findMany({
      where: { businessId, debtId: id },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => serializeReminder(r as unknown as ReminderRow));
  }

  /**
   * GET /debts/:id/reminder-schedule — the auto-reminder schedule card. Derived from
   * dueDate offsets -3/0/+3/+7 at 09:00; status=sent when the step date is before now,
   * else pending. Empty when paid / archived / no dueDate.
   */
  async reminderSchedule(businessId: string, id: string): Promise<ReminderScheduleStep[]> {
    const row = await this.findRow(businessId, id);
    if (row.deleted || !row.dueDate) return [];
    const paid = await this.paidFor(businessId, id);
    if (clampKobo(row.amount - paid) <= 0) return []; // paid -> schedule stops

    const now = Date.now();
    const steps: Array<{ offset: number; label: ReminderScheduleStep['offsetLabel'] }> = [
      { offset: -3, label: '3 days before due' },
      { offset: 0, label: 'On due date' },
      { offset: 3, label: '3 days overdue' },
      { offset: 7, label: 'Final follow-up' },
    ];
    const due = row.dueDate;
    return steps.map(({ offset, label }) => {
      const d = new Date(
        Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate() + offset, 9, 0, 0),
      );
      return {
        offsetLabel: label,
        date: d.toISOString(),
        status: d.getTime() < now ? 'sent' : 'pending',
      };
    });
  }

  // --- helpers ---------------------------------------------------------------

  private async findRow(businessId: string, id: string): Promise<DebtRow> {
    const row = await this.prisma.debt.findFirst({
      where: { id, businessId },
      include: { customer: { select: { id: true, name: true, phone: true } } },
    });
    if (!row) throw new NotFoundAppException('Debt not found');
    return row as unknown as DebtRow;
  }

  private async paidFor(businessId: string, debtId: string): Promise<number> {
    const agg = await this.prisma.payment.aggregate({
      where: { businessId, debtId },
      _sum: { amount: true },
    });
    return agg._sum.amount ?? 0;
  }

  private async paidByDebt(businessId: string, debtIds: string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (debtIds.length === 0) return map;
    const grouped = await this.prisma.payment.groupBy({
      by: ['debtId'],
      where: { businessId, debtId: { in: debtIds } },
      _sum: { amount: true },
    });
    for (const g of grouped) map.set(g.debtId, g._sum.amount ?? 0);
    return map;
  }

  private toView(row: DebtRow, paidAmount: number): DebtView {
    const remaining = clampKobo(row.amount - paidAmount);
    const dueMs = row.dueDate ? row.dueDate.getTime() : null;
    const status = deriveStatus(remaining, dueMs, Date.now(), paidAmount, row.lastReminderAt);
    return {
      id: row.id,
      businessId: row.businessId,
      customerId: row.customerId,
      amount: row.amount,
      note: row.note,
      dueDate: row.dueDate ? row.dueDate.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      lastReminderAt: row.lastReminderAt ? row.lastReminderAt.toISOString() : null,
      nextReminderAt: row.nextReminderAt ? row.nextReminderAt.toISOString() : null,
      deleted: row.deleted,
      updatedAt: row.updatedAt.toISOString(),
      version: row.version,
      paidAmount,
      remaining,
      status,
      customer: { id: row.customer.id, name: row.customer.name, phone: row.customer.phone },
    };
  }
}

/** Derive a DebtView status. remaining<=0 -> paid; else severity order overdue>partial>reminder>scheduled>outstanding. */
function deriveStatus(
  remaining: number,
  dueMs: number | null,
  now: number,
  paidAmount: number,
  lastReminderAt: Date | null,
): DebtStatus {
  if (remaining <= 0) return 'paid';
  if (dueMs !== null && dueMs < now) return 'overdue';
  if (paidAmount > 0) return 'partial';
  if (lastReminderAt) return 'reminder';
  if (dueMs !== null && dueMs >= now) return 'scheduled';
  return 'outstanding';
}

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

function serializePayment(p: PaymentRow): Payment {
  return {
    id: p.id,
    businessId: p.businessId,
    debtId: p.debtId,
    amount: p.amount,
    method: p.method,
    reference: p.reference,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    version: p.version,
  };
}

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

function serializeReminder(r: ReminderRow): Reminder {
  return {
    id: r.id,
    businessId: r.businessId,
    debtId: r.debtId,
    channel: r.channel as Reminder['channel'],
    status: r.status as Reminder['status'],
    message: r.message,
    scheduledFor: r.scheduledFor ? r.scheduledFor.toISOString() : null,
    sentAt: r.sentAt ? r.sentAt.toISOString() : null,
    payLinkUrl: r.payLinkUrl,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    version: r.version,
  };
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
