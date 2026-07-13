import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  PAYSTACK_GATEWAY,
  PaystackGateway,
  RECEIPT_VERIFIER,
  ReceiptVerifier,
  UnauthenticatedException,
  uuidv7,
} from '../common';
import { IapPlatform, PlanId } from '../shared';
import { CreditLedgerService } from '../usage/credit-ledger.service';
import { SendAllowanceService } from '../usage/send-allowance.service';

/** Uniform 200 ack body for a processed/ignored webhook (providers only care about the 200). */
export interface WebhookAck {
  received: true;
  processed: boolean;
}

/** Loose provider payload shapes — external, provider-defined. We only trust fields AFTER verification. */
interface PaystackEvent {
  event?: string;
  data?: {
    reference?: string;
    amount?: number; // kobo
    metadata?: { debtId?: string; businessId?: string; customerId?: string } | null;
  } | null;
}

interface IapEvent {
  platform?: IapPlatform;
  productId?: string;
  receipt?: string; // signed payload / receipt the RECEIPT_VERIFIER checks
  businessId?: string; // appAccountToken -> tenant (part of the signed payload; trusted post-verify)
  notificationType?: string; // e.g. SUBSCRIBED / DID_RENEW / EXPIRED / CANCELLED
}

/** IAP notification types that END entitlement (subscription lifecycle). */
const IAP_EXPIRE_TYPES = new Set([
  'EXPIRED',
  'CANCELLED',
  'DID_FAIL_TO_RENEW',
  'REVOKE',
  'GRACE_PERIOD_EXPIRED',
]);

/** Days of entitlement granted on a successful subscription notification. */
const RENEWAL_DAYS = 30;

/**
 * WebhooksService — inbound provider webhooks (Paystack charges, IAP server notifications).
 *
 * BOTH endpoints are unauthenticated by user (routes are @Public); the ONLY trust boundary is
 * the provider signature. We NEVER act on an unverified payload:
 *   - Paystack: HMAC verified via the injected PAYSTACK_GATEWAY.verifySignature over the RAW body.
 *   - IAP:      the signed receipt/payload is verified via the injected RECEIPT_VERIFIER.
 *
 * Both are idempotent so a provider retry never double-applies:
 *   - Paystack is idempotent on data.reference (a Payment already bearing that reference is a no-op).
 *   - IAP is idempotent on the store transaction id (the BillingTransaction primary key).
 *
 * This service reads/writes only Payment/Debt/Subscription/Business/BillingTransaction TABLES via
 * Prisma and credits ledgers through the UsageModule-exported services; it edits no shared code.
 */
@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sends: SendAllowanceService,
    private readonly credits: CreditLedgerService,
    @Inject(PAYSTACK_GATEWAY) private readonly paystack: PaystackGateway,
    @Inject(RECEIPT_VERIFIER) private readonly verifier: ReceiptVerifier,
  ) {}

  // --- Paystack --------------------------------------------------------------

  /**
   * POST /webhooks/paystack. Verifies the HMAC signature over the raw body, then (only for a
   * charge.success) records the debtor's pay-link payment against the target debt. Idempotent
   * on data.reference. Always 200 for a verified event, even when there is nothing to reconcile.
   */
  async handlePaystack(rawBody: Buffer, body: PaystackEvent, signature?: string): Promise<WebhookAck> {
    if (!signature || !this.paystack.verifySignature(rawBody, signature)) {
      throw new UnauthenticatedException('Invalid Paystack signature');
    }

    if (body?.event !== 'charge.success') {
      return { received: true, processed: false }; // verified but not a charge we reconcile
    }

    const data = body.data ?? {};
    const reference = data.reference;
    const amount = data.amount;
    const debtId = data.metadata?.debtId;
    if (!reference || typeof amount !== 'number' || !debtId) {
      return { received: true, processed: false }; // nothing actionable
    }

    // Idempotent on the Paystack reference: a Payment already bearing it -> no-op.
    const existing = await this.prisma.payment.findFirst({ where: { reference } });
    if (existing) {
      return { received: true, processed: false };
    }

    // Resolve the target debt from the pay-link metadata; unknown debt -> ack without recording.
    const debt = await this.prisma.debt.findUnique({ where: { id: debtId } });
    if (!debt) {
      return { received: true, processed: false };
    }

    await this.prisma.payment.create({
      data: {
        id: uuidv7(),
        businessId: debt.businessId,
        debtId: debt.id,
        amount,
        method: 'Paystack link',
        reference,
      },
    });

    // Settle: when the balance reaches 0 the reminder schedule stops (nextReminderAt cleared).
    const paid = await this.prisma.payment.aggregate({
      where: { businessId: debt.businessId, debtId: debt.id },
      _sum: { amount: true },
    });
    if ((paid._sum.amount ?? 0) >= debt.amount) {
      await this.prisma.debt.update({ where: { id: debt.id }, data: { nextReminderAt: null } });
    }

    return { received: true, processed: true };
  }

  // --- IAP -------------------------------------------------------------------

  /**
   * POST /webhooks/iap. App Store Server Notifications / Play RTDN. Verifies the signed payload
   * via RECEIPT_VERIFIER, then applies out-of-band: subscription lifecycle -> Subscription +
   * Business.plan; consumable bundle -> the matching ledger. Idempotent on the store transaction id.
   */
  async handleIap(body: IapEvent): Promise<WebhookAck> {
    if (!body?.platform || !body?.productId || !body?.receipt) {
      throw new UnauthenticatedException('Malformed IAP notification');
    }

    const result = await this.verifier.verify({
      platform: body.platform,
      productId: body.productId,
      receipt: body.receipt,
    });
    if (!result.valid) {
      throw new UnauthenticatedException('IAP notification could not be verified');
    }

    // Idempotent on the store transaction id (BillingTransaction primary key).
    const already = await this.prisma.billingTransaction.findUnique({
      where: { id: result.transactionId },
    });
    if (already) {
      return { received: true, processed: false };
    }

    const businessId = body.businessId;
    if (!businessId) {
      return { received: true, processed: false }; // no tenant to attribute the event to
    }
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) {
      return { received: true, processed: false };
    }

    const productId = result.productId || body.productId;

    // 1) Consumable bundles credited out-of-band.
    // (amount 0: the store price is not carried on the out-of-band notification — the
    //  BillingTransaction row exists here to key idempotency on the store transaction id.)
    const sends = /^oweme_sends_(\d+)$/.exec(productId);
    if (sends) {
      await this.sends.creditSend(businessId, Number(sends[1]));
      await this.recordTxn(result.transactionId, businessId, 'messages-bundle', productId, 0);
      return { received: true, processed: true };
    }
    const ai = /^oweme_ai_credits_(\d+)$/.exec(productId);
    if (ai) {
      await this.credits.creditCredits(businessId, Number(ai[1]), 'iap-webhook');
      await this.recordTxn(result.transactionId, businessId, 'ai-bundle', productId, 0);
      return { received: true, processed: true };
    }

    // 2) Subscription lifecycle (plan product resolved from the seeded Plan catalog).
    const plan = await this.prisma.plan.findFirst({ where: { productId } });
    if (plan) {
      await this.applySubscription(businessId, plan.id as PlanId, body.notificationType);
      await this.recordTxn(result.transactionId, businessId, 'subscription', productId, plan.pricePerMonth);
      return { received: true, processed: true };
    }

    return { received: true, processed: false }; // verified but unknown product
  }

  private async applySubscription(
    businessId: string,
    planId: PlanId,
    notificationType?: string,
  ): Promise<void> {
    const expiring = notificationType ? IAP_EXPIRE_TYPES.has(notificationType) : false;

    if (expiring) {
      // Lifecycle end: entitlement expires, fail closed to starter.
      await this.prisma.business.update({ where: { id: businessId }, data: { plan: 'starter' } });
      await this.prisma.subscription.upsert({
        where: { businessId },
        create: {
          businessId,
          planId,
          entitlementState: 'expired',
          activePlanId: 'starter',
          renewalAt: null,
        },
        update: { entitlementState: 'expired', activePlanId: 'starter', renewalAt: null },
      });
      return;
    }

    const renewalAt = new Date(Date.now() + RENEWAL_DAYS * 24 * 60 * 60 * 1000);
    await this.prisma.business.update({ where: { id: businessId }, data: { plan: planId } });
    await this.prisma.subscription.upsert({
      where: { businessId },
      create: { businessId, planId, entitlementState: 'active', activePlanId: planId, renewalAt },
      update: { planId, entitlementState: 'active', activePlanId: planId, renewalAt },
    });
  }

  private recordTxn(
    id: string,
    businessId: string,
    kind: string,
    productId: string,
    amount: number,
  ): Promise<unknown> {
    return this.prisma.billingTransaction.create({
      data: { id, businessId, kind, productId, label: productId, amount },
    });
  }
}
