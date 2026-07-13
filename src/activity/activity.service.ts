import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityItem, PAGINATION_DEFAULT_LIMIT, Paginated, PaginationQueryDto } from '../shared';

type CustomerStub = { id: string; name: string; phone: string };

type DebtRow = {
  id: string;
  amount: number;
  note: string | null;
  createdAt: Date;
  customer: CustomerStub;
};

type PaymentRow = {
  amount: number;
  createdAt: Date;
  debtId: string;
};

type ReminderRow = {
  channel: string;
  sentAt: Date | null;
  debtId: string;
};

/**
 * Activity — a DERIVED, read-only feed. No own table. Tenant-scoped by the JWT businessId.
 *
 * Union of three sources (all sorted `at` desc, then cursor-paginated):
 *   - every Payment            -> kind=payment,  title 'Payment received', subtitle=customer.name,                 amount=payment.amount, at=payment.createdAt
 *   - every non-deleted Debt   -> kind=debt,     title 'Debt added',      subtitle=customer.name[+' · '+note],    amount=debt.amount,    at=debt.createdAt
 *   - every SENT Reminder      -> kind=reminder, title 'Reminder sent',   subtitle=customer.name+' · '+channel,   amount=null,           at=reminder.sentAt
 *
 * Items whose parent debt is gone (soft-deleted or absent) are EXCLUDED — so payments and
 * reminders are only surfaced when their debt is still a live (non-deleted) row. Money is kobo (S-1).
 */
@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /activity — merged derived feed, `at` desc, cursor-paginated. */
  async list(businessId: string, query: PaginationQueryDto): Promise<Paginated<ActivityItem>> {
    // Live (non-deleted) debts are the spine: payments/reminders on a gone debt are excluded.
    const debts = (await this.prisma.debt.findMany({
      where: { businessId, deleted: false },
      include: { customer: { select: { id: true, name: true, phone: true } } },
    })) as unknown as DebtRow[];

    const debtById = new Map<string, DebtRow>(debts.map((d) => [d.id, d]));
    const liveDebtIds = [...debtById.keys()];

    const [payments, reminders] = await Promise.all([
      this.prisma.payment.findMany({
        where: { businessId, debtId: { in: liveDebtIds } },
        select: { amount: true, createdAt: true, debtId: true },
      }) as unknown as Promise<PaymentRow[]>,
      this.prisma.reminder.findMany({
        where: { businessId, debtId: { in: liveDebtIds }, sentAt: { not: null } },
        select: { channel: true, sentAt: true, debtId: true },
      }) as unknown as Promise<ReminderRow[]>,
    ]);

    const items: ActivityItem[] = [];

    for (const d of debts) {
      const note = d.note?.trim();
      items.push({
        kind: 'debt',
        title: 'Debt added',
        subtitle: note ? `${d.customer.name} · ${note}` : d.customer.name,
        amount: d.amount,
        at: d.createdAt.toISOString(),
      });
    }

    for (const p of payments) {
      const debt = debtById.get(p.debtId);
      if (!debt) continue; // parent debt gone -> exclude
      items.push({
        kind: 'payment',
        title: 'Payment received',
        subtitle: debt.customer.name,
        amount: p.amount,
        at: p.createdAt.toISOString(),
      });
    }

    for (const r of reminders) {
      const debt = debtById.get(r.debtId);
      if (!debt || !r.sentAt) continue; // parent debt gone / not sent -> exclude
      items.push({
        kind: 'reminder',
        title: 'Reminder sent',
        subtitle: `${debt.customer.name} · ${r.channel}`,
        amount: null,
        at: r.sentAt.toISOString(),
      });
    }

    // Sort `at` desc (newest first) over the merged feed.
    items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

    // Cursor pagination — opaque base64 offset over the deterministic sorted list.
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;
    const offset = decodeCursor(query.cursor);
    const page = items.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    const nextCursor = nextOffset < items.length ? encodeCursor(nextOffset) : null;
    return { data: page, nextCursor };
  }
}

/** Opaque cursor = base64url(offset). */
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
