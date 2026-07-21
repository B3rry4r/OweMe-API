import { Injectable } from '@nestjs/common';
import type { Business, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ForbiddenAppException, NotFoundAppException, ValidationException } from '../../common';
import { PlanId } from '../../shared';
import { CreditLedgerService } from '../../usage/credit-ledger.service';
import { currentPeriodStart } from '../../usage/period.util';
import { resolvePlanGrants } from '../../usage/plan-grants';
import { AdminPrincipal } from '../common';
import { AdminAuditService } from '../audit/admin-audit.service';
import { AdminBusinessesService } from '../businesses/admin-businesses.service';
import {
  AdminBusinessDetailView,
  AdminCreditUsageView,
} from '../businesses/admin-businesses.views';
import { AdminResetTestBusinessView } from './admin-business-actions.views';

/**
 * Enterprise banding, in KOBO (the live money unit; ceilings are BigInt columns because
 * rev 2 values exceed 32-bit Int). Base is read from the seeded enterprise Plan row and
 * only falls back to this constant if the catalog is unseeded (fail-closed to the
 * documented base rather than to an accidental 0 ceiling).
 */
export const ENTERPRISE_BASE_CEILING_KOBO = 40_000_000 * 100; // N40M
export const ENTERPRISE_BAND_CEILING_KOBO = 20_000_000 * 100; // +N20M per band

/**
 * Business write actions (registry AdminBusinessActions, superadmin only). Every method
 * here mutates a LIVE tenant, so each one records an admin_audit_log row through the ONE
 * audit writer with a truthful before/after taken from the row as it actually was.
 *
 * Mutation semantics deliberately mirror the protected registry:
 *   - Business itself is NEVER deleted (tenant root, no delete path anywhere).
 *   - force-plan reuses the billing service's plan+Subscription lockstep (the registry
 *     warns that out-of-band Business.plan edits diverge from Subscription) but writes NO
 *     BillingTransaction row: those rows are the IAP idempotency ledger and the counter
 *     for the 2-bundles-per-month cap, so admin inserts would consume a trader's cap.
 *   - grant-credits goes through CreditLedgerService.creditCredits (increment), never a
 *     raw balance write, so bundle carry-over rules survive.
 *   - reset-test is the ONE sanctioned hard wipe (conventions power 4). It refuses on any
 *     business that is not test-flagged, the check is re-asserted INSIDE the transaction,
 *     and every statement is additionally scoped to the tenant AND the flag so another
 *     tenant's rows are structurally unreachable.
 *
 * SUSPENSION SCOPE: suspend/unsuspend record Business.suspendedAt and nothing else. The
 * ENFORCEMENT of suspension (blocking NEW debt creation for a suspended business;
 * collection is never blocked, mirroring the BVUM philosophy) lives in the PROTECTED
 * src/debts/debts.service.ts and is a separate owner-authorized change, NOT made here
 * (registry followUp 'followup-suspension-enforcement'). Until it lands, suspension is a
 * recorded state the dashboard reflects.
 */
@Injectable()
export class AdminBusinessActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly businesses: AdminBusinessesService,
    private readonly credits: CreditLedgerService,
  ) {}

  /**
   * POST /admin/businesses/:id/test-flag - mark/unmark a test account (conventions power 1).
   * Re-runnable: setting the flag to the value it already holds is a no-op write whose
   * audit row honestly shows an unchanged before/after.
   */
  async setTestFlag(
    actor: AdminPrincipal,
    id: string,
    isTest: boolean,
  ): Promise<AdminBusinessDetailView> {
    const business = await this.requireBusiness(id);
    const updated = await this.prisma.business.update({ where: { id }, data: { isTest } });

    await this.audit.record(actor, {
      actionType: 'test-flag',
      action: `${actor.name} ${isTest ? 'marked' : 'unmarked'} ${business.businessName} as a test account`,
      targetType: 'Business',
      targetId: business.id,
      targetBusinessId: business.id,
      before: { isTest: business.isTest },
      after: { isTest: updated.isTest },
    });
    return this.businesses.detail(id);
  }

  /**
   * POST /admin/businesses/:id/grant-credits - additive grant (conventions power 3),
   * allowed on non-test businesses too (sales/goodwill path). Always an INCREMENT through
   * the live ledger semantics; the endpoint has no way to set a balance absolutely.
   */
  async grantCredits(
    actor: AdminPrincipal,
    id: string,
    credits: number,
  ): Promise<AdminCreditUsageView> {
    const business = await this.requireBusiness(id);
    // Raw read BEFORE the grant: creditCredits lazily creates/refills the ledger, so this
    // is the only point at which the true prior balance is observable.
    const ledgerBefore = await this.prisma.creditLedger.findUnique({ where: { businessId: id } });
    const balance = await this.credits.creditCredits(id, credits, 'admin-grant');

    await this.audit.record(actor, {
      actionType: 'grant-credits',
      action: `${actor.name} granted ${credits} OweMe credits to ${business.businessName}`,
      targetType: 'Business',
      targetId: business.id,
      targetBusinessId: business.id,
      before: { balance: ledgerBefore === null ? null : ledgerBefore.balance },
      after: { balance, granted: credits },
      note: ledgerBefore === null ? 'Ledger was created by this grant' : undefined,
    });
    return this.businesses.creditUsage(id);
  }

  /**
   * POST /admin/businesses/:id/force-plan - sales provisioning (conventions power 3).
   * Business.plan and Subscription move together in one transaction, exactly as the live
   * billing verify-receipt path does. renewalAt is left ALONE (an admin grant has no store
   * renewal date to claim); a store-driven IAP lifecycle event can later overwrite the
   * plan, which the audit note states.
   */
  async forcePlan(
    actor: AdminPrincipal,
    id: string,
    plan: PlanId,
  ): Promise<AdminBusinessDetailView> {
    const business = await this.requireBusiness(id);
    const planRow = await this.prisma.plan.findUnique({ where: { id: plan } });
    if (!planRow) throw new ValidationException(`Unknown plan: ${plan}`);

    const subscriptionBefore = await this.prisma.subscription.findUnique({
      where: { businessId: id },
    });

    await this.prisma.$transaction([
      this.prisma.business.update({ where: { id }, data: { plan } }),
      this.prisma.subscription.upsert({
        where: { businessId: id },
        create: {
          businessId: id,
          planId: plan,
          entitlementState: 'active',
          activePlanId: plan,
        },
        update: {
          planId: plan,
          entitlementState: 'active',
          activePlanId: plan,
        },
      }),
    ]);

    await this.audit.record(actor, {
      actionType: 'force-plan',
      action: `${actor.name} set ${business.businessName} to the ${planRow.name} plan`,
      targetType: 'Business',
      targetId: business.id,
      targetBusinessId: business.id,
      before: {
        plan: business.plan,
        subscriptionState: subscriptionBefore?.entitlementState ?? null,
        activePlanId: subscriptionBefore?.activePlanId ?? null,
      },
      after: { plan, subscriptionState: 'active', activePlanId: plan },
      note: 'Holds until the next renewal; a store-driven IAP lifecycle event can overwrite it.',
    });
    return this.businesses.detail(id);
  }

  /**
   * POST /admin/businesses/:id/enterprise-bands - rev 2 enterprise banding. Writes the band
   * COUNT and the DERIVED effective ceiling together, so BvumService (which reads
   * bvumCeilingOverride) enforces the provisioned ceiling immediately. Price math
   * (25000 + 12500 x bands) stays display-side; no price is persisted here.
   * Re-runnable: the ceiling is recomputed from the band count, never accumulated.
   */
  async setEnterpriseBands(
    actor: AdminPrincipal,
    id: string,
    extraBands: number,
  ): Promise<AdminBusinessDetailView> {
    const business = await this.requireBusiness(id);
    if (business.plan !== 'enterprise') {
      throw new ValidationException('Enterprise bands apply to the enterprise plan only', [
        { field: 'extraBands', message: `business is on the ${business.plan} plan` },
      ]);
    }

    const base = await this.enterpriseBaseCeilingKobo();
    const ceiling = base + extraBands * ENTERPRISE_BAND_CEILING_KOBO;
    const updated = await this.prisma.business.update({
      where: { id },
      data: { enterpriseBands: extraBands, bvumCeilingOverride: BigInt(ceiling) },
    });

    await this.audit.record(actor, {
      actionType: 'enterprise-bands',
      action: `${actor.name} set ${business.businessName} to ${extraBands} extra enterprise band(s)`,
      targetType: 'Business',
      targetId: business.id,
      targetBusinessId: business.id,
      before: {
        extraBands: business.enterpriseBands,
        bvumCeilingOverrideKobo:
          business.bvumCeilingOverride === null ? null : Number(business.bvumCeilingOverride),
      },
      after: {
        extraBands: updated.enterpriseBands,
        bvumCeilingOverrideKobo: Number(updated.bvumCeilingOverride),
        baseCeilingKobo: base,
      },
    });
    return this.businesses.detail(id);
  }

  /**
   * POST /admin/businesses/:id/suspend - gap-5 lifecycle. Records suspendedAt only; see the
   * SUSPENSION SCOPE note on this class for why enforcement is not implemented here.
   * Already-suspended -> 422, so a double submit can never re-stamp the suspension date.
   */
  async suspend(
    actor: AdminPrincipal,
    id: string,
    note?: string,
  ): Promise<AdminBusinessDetailView> {
    const business = await this.requireBusiness(id);
    if (business.suspendedAt !== null) {
      throw new ValidationException('Business is already suspended');
    }

    const updated = await this.prisma.business.update({
      where: { id },
      data: { suspendedAt: new Date() },
    });

    await this.audit.record(actor, {
      actionType: 'suspend',
      action: `${actor.name} suspended ${business.businessName}`,
      targetType: 'Business',
      targetId: business.id,
      targetBusinessId: business.id,
      before: { suspendedAt: null },
      after: { suspendedAt: updated.suspendedAt!.toISOString() },
      note,
    });
    return this.businesses.detail(id);
  }

  /** POST /admin/businesses/:id/unsuspend - clears suspendedAt. Not suspended -> 422. */
  async unsuspend(actor: AdminPrincipal, id: string): Promise<AdminBusinessDetailView> {
    const business = await this.requireBusiness(id);
    if (business.suspendedAt === null) {
      throw new ValidationException('Business is not suspended');
    }

    await this.prisma.business.update({ where: { id }, data: { suspendedAt: null } });

    await this.audit.record(actor, {
      actionType: 'unsuspend',
      action: `${actor.name} lifted the suspension on ${business.businessName}`,
      targetType: 'Business',
      targetId: business.id,
      targetBusinessId: business.id,
      before: { suspendedAt: business.suspendedAt.toISOString() },
      after: { suspendedAt: null },
    });
    return this.businesses.detail(id);
  }

  /**
   * POST /admin/businesses/:id/reset-test - conventions power 4, the ONLY hard wipe on the
   * admin surface and the ONLY place the app's soft-delete rules are set aside, by explicit
   * owner approval and ONLY behind Business.isTest.
   *
   * Refusals: 404 unknown id, 403 when the business is not test-flagged (structural,
   * server-side), 422 when `confirm` does not equal the business name.
   *
   * Tenant isolation is enforced three ways: the pre-check, a re-assertion of isTest inside
   * the transaction, and a WHERE clause on every statement that names BOTH the tenant id and
   * the test flag - so no statement can reach another tenant's rows even if the flag flipped
   * mid-flight. The Business row itself is never deleted (tenant root has no delete path).
   * Re-runnable: a second reset simply clears nothing and reports zeros.
   */
  async resetTestBusiness(
    actor: AdminPrincipal,
    id: string,
    confirm: string,
  ): Promise<AdminResetTestBusinessView> {
    const business = await this.requireBusiness(id);
    if (!business.isTest) {
      throw new ForbiddenAppException('Reset is only available for test-flagged businesses');
    }
    if (confirm !== business.businessName) {
      throw new ValidationException('Confirmation does not match the business name', [
        { field: 'confirm', message: 'must equal the business name exactly' },
      ]);
    }

    // The ledger is reset to the plan's grant with the bonus removed, so a reset test
    // account starts the period exactly like a fresh signup on the same plan.
    const grant = (await resolvePlanGrants(this.prisma, id)).creditsPerMonth;

    const cleared = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const target = await tx.business.findUnique({ where: { id }, select: { isTest: true } });
      if (!target || !target.isTest) {
        throw new ForbiddenAppException('Reset is only available for test-flagged businesses');
      }

      // businessId AND the flag on every statement: another tenant is unreachable by shape.
      const scope = { businessId: id, business: { isTest: true } };
      const payments = await tx.payment.deleteMany({ where: scope });
      const reminders = await tx.reminder.deleteMany({ where: scope });
      const debts = await tx.debt.deleteMany({ where: scope });
      const customers = await tx.customer.deleteMany({ where: scope });
      const notifications = await tx.notification.deleteMany({ where: scope });
      // usage_events carries no relation (append-only event table), so it is scoped by the
      // tenant id under the isTest assertion re-checked above in this same transaction.
      const usageEvents = await tx.usageEvent.deleteMany({ where: { businessId: id } });

      const period = currentPeriodStart();
      await tx.creditLedger.upsert({
        where: { businessId: id },
        create: { businessId: id, balance: grant, monthlyGrant: grant, periodStart: period },
        update: { balance: grant, monthlyGrant: grant, periodStart: period },
      });

      return {
        debts: debts.count,
        payments: payments.count,
        reminders: reminders.count,
        customers: customers.count,
        notifications: notifications.count,
        usageEvents: usageEvents.count,
      };
    });

    await this.audit.record(actor, {
      actionType: 'reset-test-business',
      action: `${actor.name} wiped test business ${business.businessName}`,
      targetType: 'Business',
      targetId: business.id,
      targetBusinessId: business.id,
      before: { isTest: true, confirmed: business.businessName },
      after: { cleared, creditLedgerResetTo: grant },
      note: 'Hard wipe of the test business own rows only; the Business row is never deleted.',
    });

    return {
      ok: true,
      cleared: {
        debts: cleared.debts,
        payments: cleared.payments,
        reminders: cleared.reminders,
      },
    };
  }

  // --- internals -----------------------------------------------------------

  private async requireBusiness(id: string): Promise<Business> {
    const business = await this.prisma.business.findUnique({ where: { id } });
    if (!business) throw new NotFoundAppException('Business not found');
    return business;
  }

  /** Seeded enterprise base ceiling (kobo), fail-closed to the documented N40M base. */
  private async enterpriseBaseCeilingKobo(): Promise<number> {
    const planRow = await this.prisma.plan.findUnique({ where: { id: 'enterprise' } });
    return planRow && planRow.bvumCeiling !== null
      ? Number(planRow.bvumCeiling)
      : ENTERPRISE_BASE_CEILING_KOBO;
  }
}
