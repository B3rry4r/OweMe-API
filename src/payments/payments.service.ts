import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreatePaymentDto,
  DebtStatus,
  DebtView,
  Payment,
  ReceiptResponse,
} from '../shared';
import { clampKobo, ForbiddenAppException, NotFoundAppException, ValidationException } from '../common';

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

type CustomerStub = { id: string; name: string; phone: string };

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
 * Payments service. Tenant-scoped by the JWT businessId. Roles owner|staff.
 *
 * Balance is NEVER stored — a debt's remaining derives from the payment sum
 * (traditional software, never AI): remaining = clamp(debt.amount - sum(payments.amount)).
 * A payment is only accepted when 0 < amount <= remaining (overpayment -> 422). The receipt
 * `reference` is server-minted (OWM-<per-business zero-padded sequence>). This service reads
 * the Debt/Customer/Business TABLES via Prisma; it never imports another feature module.
 */
@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * POST /debts/:id/payments — record a payment against a debt. Idempotent on the
   * client-minted payment id (a re-seen id returns the existing payment, no duplicate).
   * Partial payments allowed; amount>0 (DTO) and amount<=remaining (overpayment -> 422).
   */
  async create(
    businessId: string,
    debtId: string,
    dto: CreatePaymentDto,
  ): Promise<{ payment: Payment; created: boolean }> {
    const existing = (await this.prisma.payment.findUnique({
      where: { id: dto.id },
    })) as unknown as PaymentRow | null;
    if (existing) {
      if (existing.businessId !== businessId) {
        throw new ForbiddenAppException('Payment id already exists in another business');
      }
      return { payment: serializePayment(existing), created: false };
    }

    const debt = await this.findDebt(businessId, debtId);

    const paid = await this.paidFor(businessId, debtId);
    const remaining = clampKobo(debt.amount - paid);
    if (dto.amount > remaining) {
      throw new ValidationException('Payment exceeds the outstanding balance', [
        { field: 'amount', remaining, attempted: dto.amount },
      ]);
    }

    const reference = await this.mintReference(businessId);
    const created = (await this.prisma.payment.create({
      data: {
        id: dto.id,
        businessId,
        debtId,
        amount: dto.amount,
        method: dto.method,
        reference,
      },
    })) as unknown as PaymentRow;

    return { payment: serializePayment(created), created: true };
  }

  /**
   * GET /payments/:id — receipt fetch. Returns the payment plus enough of the debt
   * (DebtView, derived) and business to render a receipt. 404 if not in tenant.
   */
  async getReceipt(businessId: string, paymentId: string): Promise<ReceiptResponse> {
    const payment = (await this.prisma.payment.findFirst({
      where: { id: paymentId, businessId },
    })) as unknown as PaymentRow | null;
    if (!payment) throw new NotFoundAppException('Payment not found');

    const debtRow = await this.findDebt(businessId, payment.debtId);
    const paid = await this.paidFor(businessId, payment.debtId);
    const debt = toDebtView(debtRow, paid);

    const business = await this.prisma.business.findUnique({ where: { id: businessId } });

    return {
      payment: serializePayment(payment),
      debt,
      business: { businessName: business?.businessName ?? '' },
    };
  }

  /**
   * POST /debts/:id/undo-payment — deletes the debt's most-recent payment (reopen) and
   * returns the removed Payment. The debt's remaining recomputes automatically from the
   * payment sum. 404 if the debt isn't in the tenant or has no payments.
   */
  async undo(businessId: string, debtId: string): Promise<Payment> {
    await this.findDebt(businessId, debtId);

    const latest = (await this.prisma.payment.findFirst({
      where: { businessId, debtId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })) as unknown as PaymentRow | null;
    if (!latest) throw new NotFoundAppException('No payment to undo for this debt');

    await this.prisma.payment.delete({ where: { id: latest.id } });
    return serializePayment(latest);
  }

  // --- helpers ---------------------------------------------------------------

  private async findDebt(businessId: string, debtId: string): Promise<DebtRow> {
    const row = await this.prisma.debt.findFirst({
      where: { id: debtId, businessId },
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

  /**
   * Mint the next per-business receipt reference: OWM-<zero-padded sequence>. The sequence
   * is one past the highest existing OWM- number in the tenant (robust to deleted rows so
   * an undo+re-record never reuses a reference). Traditional software — never AI.
   */
  private async mintReference(businessId: string): Promise<string> {
    const rows = await this.prisma.payment.findMany({
      where: { businessId },
      select: { reference: true },
    });
    let max = 0;
    for (const { reference } of rows) {
      const m = /^OWM-(\d+)$/.exec(reference);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
    return `OWM-${String(max + 1).padStart(5, '0')}`;
  }
}

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

/** DebtView derivation — mirrors the debts module (money/status derived, never stored). */
function toDebtView(row: DebtRow, paidAmount: number): DebtView {
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
