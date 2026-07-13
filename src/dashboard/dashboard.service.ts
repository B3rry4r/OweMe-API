import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityItem, DashboardResponse } from '../shared';
import { clampKobo } from '../common';

type CustomerStub = { id: string; name: string; phone: string };

type DebtWithPayments = {
  id: string;
  customerId: string;
  amount: number;
  note: string | null;
  dueDate: Date | null;
  createdAt: Date;
  deleted: boolean;
  customer: CustomerStub;
  payments: PaymentRow[];
};

type PaymentRow = {
  id: string;
  debtId: string;
  amount: number;
  method: string;
  createdAt: Date;
};

type ReminderRow = {
  id: string;
  debtId: string;
  channel: string;
  status: string;
  sentAt: Date | null;
  createdAt: Date;
};

const ACTIVITY_CAP = 8;

/**
 * Dashboard service — a DERIVED, read-only summary of the home screen. Owns no table;
 * it reads the tenant's Debt/Payment/Customer/Reminder/Notification tables via Prisma and
 * scopes every query to the JWT businessId. Core-recovery surface, never plan-gated.
 *
 * All money is integer kobo (S-1). Aggregates are computed over the tenant's NON-DELETED
 * debts (+ their payments); recovered-this-month sums those debts' payments in the current
 * calendar month; activity is the derived union of debts + payments + SENT reminders whose
 * parent debt still exists, sorted `at` desc and capped at 8.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /dashboard — the whole home summary in one shape. */
  async summary(businessId: string): Promise<DashboardResponse> {
    const debts = (await this.prisma.debt.findMany({
      where: { businessId, deleted: false },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        payments: true,
      },
    })) as unknown as DebtWithPayments[];

    const [reminders, customersCount, unreadCount] = await Promise.all([
      this.prisma.reminder.findMany({
        where: { businessId, status: 'sent' },
      }) as unknown as Promise<ReminderRow[]>,
      this.prisma.customer.count({ where: { businessId } }),
      this.prisma.notification.count({ where: { businessId, read: false } }),
    ]);

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    let outstandingTotal = 0;
    let recoveredThisMonth = 0;
    let dueTodayTotal = 0;
    let overdueTotal = 0;
    let overdueCount = 0;
    const owingCustomers = new Set<string>();

    // Debt ids that still exist (non-deleted) — used to keep activity clean of orphans.
    const liveDebtIds = new Set(debts.map((d) => d.id));
    const activity: ActivityItem[] = [];

    for (const debt of debts) {
      const paid = debt.payments.reduce((sum, p) => sum + p.amount, 0);
      const remaining = clampKobo(debt.amount - paid);

      if (remaining > 0) {
        outstandingTotal += remaining;
        owingCustomers.add(debt.customerId);
        if (debt.dueDate) {
          if (debt.dueDate < startOfToday) {
            overdueTotal += remaining;
            overdueCount += 1;
          } else if (debt.dueDate < endOfToday) {
            dueTodayTotal += remaining;
          }
        }
      }

      // recovered-this-month: this debt's payments dated in the current calendar month.
      for (const payment of debt.payments) {
        if (payment.createdAt >= startOfMonth && payment.createdAt < startOfNextMonth) {
          recoveredThisMonth += payment.amount;
        }
        activity.push({
          kind: 'payment',
          title: `Payment from ${debt.customer.name}`,
          subtitle: payment.method,
          amount: payment.amount,
          at: payment.createdAt.toISOString(),
        });
      }

      activity.push({
        kind: 'debt',
        title: `New debt · ${debt.customer.name}`,
        subtitle: debt.note ?? '',
        amount: debt.amount,
        at: debt.createdAt.toISOString(),
      });
    }

    const customerByDebt = new Map(debts.map((d) => [d.id, d.customer] as const));
    for (const reminder of reminders) {
      if (!liveDebtIds.has(reminder.debtId)) continue; // parent debt gone
      const customer = customerByDebt.get(reminder.debtId);
      const at = (reminder.sentAt ?? reminder.createdAt).toISOString();
      activity.push({
        kind: 'reminder',
        title: `Reminder sent${customer ? ` · ${customer.name}` : ''}`,
        subtitle: reminder.channel,
        amount: null,
        at,
      });
    }

    activity.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

    return {
      outstandingTotal,
      owingCustomerCount: owingCustomers.size,
      recoveredThisMonth,
      dueTodayTotal,
      overdueTotal,
      overdueCount,
      activity: activity.slice(0, ACTIVITY_CAP),
      hasAnyDebts: debts.length > 0,
      hasAnyCustomers: customersCount > 0,
      hasUnread: unreadCount > 0,
    };
  }
}
