import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  koboToNaira,
  PAYSTACK_GATEWAY,
  PaystackGateway,
  RECEIPT_VERIFIER,
  ReceiptVerifier,
  UnauthenticatedException,
  uuidv7,
} from '../common';
import { IapPlatform, PlanId } from '../shared';

/** Uniform 200 ack body for a processed/ignored webhook (providers only care about the 200). */
export interface WebhookAck {
  received: true;
  processed: boolean;
}

/** Loose provider payload shapes: external, provider-defined. We only trust fields AFTER verification. */
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
  businessId?: string; // present on some provider payloads but NEVER read; tenant binding is server-side only
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

/** Unified OweMe-credits bundle product ids (rev 2), e.g. oweme_credits_600. */
const CREDITS_BUNDLE_PRODUCT = /^oweme_credits_\d+$/;

/** Kobo -> display naira for notification copy, e.g. 250000 -> '₦2,500'. */
function formatNaira(kobo: number): string {
  return `₦${koboToNaira(kobo).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

/**
 * WebhooksService: inbound provider webhooks (Paystack charges, IAP server notifications).
 *
 * BOTH endpoints are unauthenticated by user (routes are @Public); the ONLY trust boundary is
 * the provider signature. We NEVER act on an unverified payload:
 *   - Paystack: HMAC verified via the injected PAYSTACK_GATEWAY.verifySignature over the RAW body.
 *   - IAP:      the signed receipt/payload is verified via the injected RECEIPT_VERIFIER.
 *
 * Both are idempotent so a provider retry never double-applies:
 *   - Paystack is idempotent on data.reference (a Payment already bearing that reference is a no-op).
 *   - IAP is idempotent on the store transaction id: a bundle bound to an existing
 *     BillingTransaction was already credited at verify-receipt time (no-op), and re-applying a
 *     subscription lifecycle notification upserts the same entitlement state.
 *
 * Charge-recording invariant: a VERIFIED charge is never dropped; the money arrived and must be
 * visible. The Payment row always carries the full charged amount; the debt's derived paid state
 * caps at its principal (remaining clamps to 0). Anomalous charges (archived debt, overpayment)
 * are recorded AND flagged to the owner via Notification rows instead of being rejected.
 *
 * IAP tenant binding is SERVER-SIDE ONLY: POST /billing/verify-receipt persisted the store
 * transaction id as the BillingTransaction primary key under the authenticated tenant, and that
 * row is the sole source of truth for which business a store transaction belongs to. The raw
 * notification body's businessId is never read; an event with no binding is acked and ignored.
 *
 * This service reads/writes only Payment/Debt/Customer/Notification/Subscription/Business/
 * BillingTransaction TABLES via Prisma; it edits no shared code.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
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
    const eventType = body?.event ?? 'unknown';
    const reference = body?.data?.reference ?? null;
    try {
      const ack = await this.processPaystack(rawBody, body, signature);
      await this.logWebhook('paystack', eventType, reference, ack.processed ? 'ok' : 'ignored', null);
      return ack;
    } catch (err) {
      // Unverified deliveries are NEVER logged (untrusted input); everything else is.
      if (!(err instanceof UnauthenticatedException)) {
        await this.logWebhook('paystack', eventType, reference, 'error', {
          message: String(err),
          body: body as unknown,
        });
      }
      throw err;
    }
  }

  private async processPaystack(
    rawBody: Buffer,
    body: PaystackEvent,
    signature?: string,
  ): Promise<WebhookAck> {
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

    // Record the verified charge UNCONDITIONALLY and in full: the money arrived and must be
    // visible even when the debt is archived or the charge exceeds the balance. The debt's
    // derived paid state caps at its amount (remaining clamps to 0); the Payment row never does.
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

    // Settle: at (or over) the principal the debt is fully paid and the reminder schedule stops.
    const paid = await this.prisma.payment.aggregate({
      where: { businessId: debt.businessId, debtId: debt.id },
      _sum: { amount: true },
    });
    const paidTotal = paid._sum.amount ?? 0;
    if (paidTotal >= debt.amount) {
      await this.prisma.debt.update({ where: { id: debt.id }, data: { nextReminderAt: null } });
    }
    const excess = paidTotal - debt.amount;

    const customer = await this.prisma.customer.findUnique({
      where: { id: debt.customerId },
      select: { name: true },
    });
    const payer = customer?.name ?? 'A customer';

    // App-feed Notification rows: the normal path gets a payment-received row; the anomaly
    // paths (archived debt, overpayment) get explicit owner-facing flags instead.
    if (debt.deleted) {
      // Archived stays archived: the payment is recorded but the debt is NEVER unarchived here.
      await this.createNotification(
        debt.businessId,
        'Archived debt received a payment',
        `${payer} paid ${formatNaira(amount)} on an archived debt via Paystack link. ` +
          'The debt stays archived; restore it if it should be active again.',
      );
    }
    if (excess > 0) {
      await this.createNotification(
        debt.businessId,
        'Debt overpaid',
        `${payer} paid ${formatNaira(amount)} via Paystack link. The debt is now fully paid ` +
          `and the total received exceeds it by ${formatNaira(excess)}.`,
      );
    }
    if (!debt.deleted && excess <= 0) {
      await this.createNotification(
        debt.businessId,
        'Payment received',
        `${payer} paid ${formatNaira(amount)} via Paystack link.`,
      );
    }

    return { received: true, processed: true };
  }

  // --- IAP -------------------------------------------------------------------

  /**
   * POST /webhooks/iap. App Store Server Notifications / Play RTDN. Verifies the signed payload
   * via RECEIPT_VERIFIER, resolves the tenant from the BillingTransaction persisted at
   * verify-receipt time (NEVER from the unsigned body), then applies the subscription lifecycle
   * out-of-band. Unbound or bundle-bound events are acked and ignored (no state change).
   */
  async handleIap(body: IapEvent): Promise<WebhookAck> {
    const eventType = body?.notificationType ?? 'unknown';
    try {
      const { ack, reference } = await this.processIap(body);
      await this.logWebhook('iap', eventType, reference, ack.processed ? 'ok' : 'ignored', null);
      return ack;
    } catch (err) {
      // Unverified/malformed deliveries are NEVER logged (untrusted input).
      if (!(err instanceof UnauthenticatedException)) {
        await this.logWebhook('iap', eventType, null, 'error', {
          message: String(err),
          platform: body?.platform ?? null,
          productId: body?.productId ?? null,
        });
      }
      throw err;
    }
  }

  private async processIap(body: IapEvent): Promise<{ ack: WebhookAck; reference: string | null }> {
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

    // Server-side tenant binding: the store transaction id is the BillingTransaction primary
    // key written by the authenticated verify-receipt call. No binding -> ack and ignore;
    // body.businessId is raw unsigned input and is never trusted.
    const binding = await this.prisma.billingTransaction.findUnique({
      where: { id: result.transactionId },
    });
    if (!binding) {
      this.logger.warn(
        `IAP notification ignored: no server-side tenant binding for store transaction '${result.transactionId}'`,
      );
      return { ack: { received: true, processed: false }, reference: result.transactionId };
    }
    const businessId = binding.businessId;

    const productId = result.productId || binding.productId;

    // Consumable OweMe-credits bundle: the bound transaction already credited the ledger at
    // verify-receipt time; crediting again here would double-apply. Idempotent no-op.
    if (CREDITS_BUNDLE_PRODUCT.test(productId)) {
      return { ack: { received: true, processed: false }, reference: result.transactionId };
    }

    // Subscription lifecycle on the BOUND tenant (renewal extends, expiry fails closed).
    const plan = await this.prisma.plan.findFirst({ where: { productId } });
    if (plan) {
      await this.applySubscription(businessId, plan.id as PlanId, body.notificationType);
      return { ack: { received: true, processed: true }, reference: result.transactionId };
    }

    // verified but unknown product
    return { ack: { received: true, processed: false }, reference: result.transactionId };
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

  /**
   * Best-effort webhook_event_log row (admin pay-links / billing panels). Only VERIFIED
   * deliveries are logged. Never throws: a logging failure must never fail a money path,
   * and must never turn a 200 ack into a provider retry storm.
   */
  private async logWebhook(
    source: 'paystack' | 'iap',
    eventType: string,
    reference: string | null,
    outcome: 'ok' | 'ignored' | 'error',
    detail: Record<string, unknown> | null,
  ): Promise<void> {
    try {
      await this.prisma.webhookEventLog.create({
        data: {
          id: uuidv7(),
          source,
          eventType,
          reference,
          outcome,
          detail: (detail ?? undefined) as never,
        },
      });
    } catch (err) {
      this.logger.warn(`webhook_event_log write failed (${source}/${outcome}): ${String(err)}`);
    }
  }

  /** Insert an app-feed Notification row (kind 'payment'; feed rows were previously never written). */
  private createNotification(businessId: string, title: string, body: string): Promise<unknown> {
    return this.prisma.notification.create({
      data: { id: uuidv7(), businessId, title, body, kind: 'payment' },
    });
  }
}
