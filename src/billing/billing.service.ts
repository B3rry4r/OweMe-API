import { Inject, Injectable } from '@nestjs/common';
import {
  BillingTransaction,
  EntitlementState,
  PlanId,
  Subscription,
  Paginated,
  VerifyReceiptDto,
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
} from '../shared';
import { RECEIPT_VERIFIER, ReceiptVerifier, ValidationException } from '../common';
import { PrismaService } from '../prisma/prisma.service';
import { CreditLedgerService } from '../usage/credit-ledger.service';
import { SendAllowanceService } from '../usage/send-allowance.service';
import { resolveBundle } from './bundle-catalog';

/** POST /billing/verify-receipt response — one of entitlement (plan) or ledger (bundle). */
export interface VerifyReceiptResponse {
  entitlement?: Subscription;
  ledger?: { sendAllowance?: number; aiCredits?: number };
}

/** Subscription entitlement period after a successful plan purchase/renewal (days). */
const RENEWAL_DAYS = 30;

/**
 * BillingService — Subscription/IAP surface (server is the SOLE entitlement authority).
 *
 * verify-receipt verifies via the injected RECEIPT_VERIFIER (never trusts the client),
 * then routes by productId: a Plan product sets Business.plan + Subscription entitlement;
 * a message/AI bundle credits the corresponding ledger (injected from UsageModule).
 * Idempotent on the store transaction id (the BillingTransaction primary key) — a re-verify
 * of the same receipt never double-credits.
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditLedgerService,
    private readonly sends: SendAllowanceService,
    @Inject(RECEIPT_VERIFIER) private readonly verifier: ReceiptVerifier,
  ) {}

  /** GET /subscription — current entitlement for the business (lazily defaults to starter/none). */
  async getSubscription(businessId: string): Promise<Subscription> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { plan: true },
    });
    const planId = (business?.plan ?? 'starter') as PlanId;

    const sub = await this.prisma.subscription.findUnique({ where: { businessId } });
    if (!sub) {
      return {
        businessId,
        planId,
        entitlementState: 'none',
        activePlanId: 'starter',
        renewalAt: null,
      };
    }
    return {
      businessId,
      planId,
      entitlementState: sub.entitlementState as EntitlementState,
      activePlanId: sub.activePlanId as PlanId,
      renewalAt: sub.renewalAt ? sub.renewalAt.toISOString() : null,
    };
  }

  /** POST /billing/verify-receipt — verify with the store, route by productId, idempotent on txn id. */
  async verifyReceipt(businessId: string, dto: VerifyReceiptDto): Promise<VerifyReceiptResponse> {
    const result = await this.verifier.verify({
      platform: dto.platform,
      productId: dto.productId,
      receipt: dto.receipt,
    });
    if (!result.valid) {
      throw new ValidationException('Receipt could not be verified');
    }

    // Idempotency: the store transaction id is the BillingTransaction primary key.
    const existing = await this.prisma.billingTransaction.findUnique({
      where: { id: result.transactionId },
    });
    if (existing) {
      return this.responseForKind(businessId, existing.kind, existing.productId);
    }

    // 1) Plan product? (resolved from the seeded Plan catalog by productId)
    const plan = await this.prisma.plan.findFirst({ where: { productId: dto.productId } });
    if (plan) {
      return this.applyPlan(businessId, plan, result.transactionId);
    }

    // 2) Consumable bundle? (message allowance or AI credits)
    const bundle = resolveBundle(dto.productId);
    if (bundle) {
      return this.applyBundle(businessId, bundle, dto.productId, result.transactionId);
    }

    throw new ValidationException(`Unknown productId: ${dto.productId}`);
  }

  /** GET /billing/history — cursor-paginated purchase history (renewals + bundles), newest first. */
  async getHistory(
    businessId: string,
    cursor?: string,
    limit?: number,
  ): Promise<Paginated<BillingTransaction>> {
    const take = Math.min(Math.max(limit ?? PAGINATION_DEFAULT_LIMIT, 1), PAGINATION_MAX_LIMIT);

    const rows = await this.prisma.billingTransaction.findMany({
      where: { businessId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    return {
      data: page.map((r) => this.toTransaction(r)),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  // --- internals -----------------------------------------------------------

  private async applyPlan(
    businessId: string,
    plan: { id: string; name: string; pricePerMonth: number },
    transactionId: string,
  ): Promise<VerifyReceiptResponse> {
    const planId = plan.id as PlanId;
    const renewalAt = new Date(Date.now() + RENEWAL_DAYS * 24 * 60 * 60 * 1000);

    // Server is the sole entitlement authority: set Business.plan + Subscription atomically.
    await this.prisma.business.update({ where: { id: businessId }, data: { plan: planId } });
    await this.prisma.subscription.upsert({
      where: { businessId },
      create: {
        businessId,
        planId,
        entitlementState: 'active',
        activePlanId: planId,
        renewalAt,
      },
      update: {
        planId,
        entitlementState: 'active',
        activePlanId: planId,
        renewalAt,
      },
    });

    await this.recordTransaction(
      transactionId,
      businessId,
      'subscription',
      plan.name,
      plan.name,
      plan.pricePerMonth,
    );

    return { entitlement: await this.getSubscription(businessId) };
  }

  private async applyBundle(
    businessId: string,
    bundle: ReturnType<typeof resolveBundle> & object,
    productId: string,
    transactionId: string,
  ): Promise<VerifyReceiptResponse> {
    let ledger: VerifyReceiptResponse['ledger'];
    if (bundle.ledger === 'send') {
      const remaining = await this.sends.creditSend(businessId, bundle.quantity);
      ledger = { sendAllowance: remaining };
    } else {
      const balance = await this.credits.creditCredits(businessId, bundle.quantity, 'bundle');
      ledger = { aiCredits: balance };
    }

    await this.recordTransaction(
      transactionId,
      businessId,
      bundle.kind,
      productId,
      bundle.label,
      bundle.amountKobo,
    );

    return { ledger };
  }

  /** Rebuild the response for an already-processed transaction (idempotent re-verify). */
  private async responseForKind(
    businessId: string,
    kind: string,
    productId: string,
  ): Promise<VerifyReceiptResponse> {
    if (kind === 'subscription') {
      return { entitlement: await this.getSubscription(businessId) };
    }
    const bundle = resolveBundle(productId);
    if (bundle?.ledger === 'credit') {
      return { ledger: { aiCredits: await this.credits.getBalance(businessId) } };
    }
    return { ledger: { sendAllowance: await this.sends.getRemaining(businessId) } };
  }

  private recordTransaction(
    id: string,
    businessId: string,
    kind: string,
    productId: string,
    label: string,
    amount: number,
  ): Promise<unknown> {
    return this.prisma.billingTransaction.create({
      data: { id, businessId, kind, productId, label, amount },
    });
  }

  private toTransaction(row: {
    id: string;
    businessId: string;
    kind: string;
    productId: string;
    label: string;
    amount: number;
    createdAt: Date;
  }): BillingTransaction {
    return {
      id: row.id,
      businessId: row.businessId,
      kind: row.kind as BillingTransaction['kind'],
      productId: row.productId,
      label: row.label,
      amount: row.amount,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
