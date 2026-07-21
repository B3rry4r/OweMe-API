import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotFoundAppException } from '../../common';
import { AdminPrincipal } from '../common';
import { AdminAuditService } from '../audit/admin-audit.service';
import { AdminOtpRevealView } from './admin-otp-reveal.views';

/**
 * Test-account OTP reveal (registry AdminOtpReveal, conventions power 2; superadmin only).
 *
 * SECURITY SHAPE, all of it structural rather than conventional:
 * - The protected OtpCode table stores codeHash only and is NEVER read here (or anywhere
 *   in src/admin). Real users' codes stay hashed and unreachable by construction, and this
 *   surface would keep working unchanged if the hashing got stronger tomorrow.
 * - The only readable source is the otp_test_codes SIDE TABLE, which the auth.service
 *   instrumentation populates solely when the requesting phone maps to an isTest business.
 * - The lookup starts from Business WHERE id = ? AND isTest = true and reaches the side
 *   table only through that row's phone. A stray side-table row for a real user's phone is
 *   therefore still unreachable: there is no query path to it.
 * - Codes are expiry-aware (expiresAt > now), matching the live 10-minute OTP TTL, so an
 *   expired row reveals nothing.
 * - Business missing, business not test-flagged and no active code all produce the SAME
 *   404 with the SAME message, so the endpoint cannot be used to probe which businesses
 *   are test accounts. The audit row records the truthful reason.
 *
 * Nothing outside admin_audit_log is written: no code is consumed, no row is deleted
 * (the app's OtpCode consumption semantics are untouched), so a reveal is pure and
 * repeating it returns the same code until the code expires.
 */

/** One message for every refusal path; the caller learns nothing from the difference. */
const REVEAL_NOT_FOUND_MESSAGE = 'No active test OTP code for this business';

type RevealRefusal = 'business-not-found' | 'business-not-test-flagged' | 'no-active-code';

@Injectable()
export class AdminOtpRevealService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * POST /admin/auth-monitor/test-numbers/:businessId/reveal - 200 AdminOtpRevealView
   * or 404 NOT_FOUND. Every attempt, granted or refused, leaves a 'reveal-otp' audit row;
   * the plaintext code is NEVER written to the log (support can read admin_audit_log).
   */
  async reveal(actor: AdminPrincipal, businessId: string): Promise<AdminOtpRevealView> {
    // Structural gate: isTest lives in the WHERE clause, not in an if-statement after the read.
    const business = await this.prisma.business.findFirst({
      where: { id: businessId, isTest: true },
      select: { id: true, businessName: true, phone: true },
    });
    if (!business) {
      // Distinguish the two refusals for the audit trail only, with a second read that
      // returns nothing but existence (never a phone, never a code).
      const exists = await this.prisma.business.count({ where: { id: businessId } });
      await this.recordRefusal(
        actor,
        businessId,
        exists > 0 ? 'business-not-test-flagged' : 'business-not-found',
        exists > 0 ? businessId : null,
      );
      throw new NotFoundAppException(REVEAL_NOT_FOUND_MESSAGE);
    }

    const now = new Date();
    const testCode = await this.prisma.otpTestCode.findFirst({
      where: { phone: business.phone, expiresAt: { gt: now } },
    });
    // Empty side table (the state until the auth.service instrumentation lands) is a normal
    // no-code outcome, not an error condition: same 404 as an expired code.
    if (!testCode) {
      await this.recordRefusal(actor, businessId, 'no-active-code', businessId);
      throw new NotFoundAppException(REVEAL_NOT_FOUND_MESSAGE);
    }

    const expiresInSeconds = Math.max(
      1,
      Math.ceil((testCode.expiresAt.getTime() - now.getTime()) / 1000),
    );
    await this.audit.record(actor, {
      actionType: 'reveal-otp',
      action: `${actor.name} revealed the current OTP code for test business ${business.businessName}`,
      targetType: 'Business',
      targetId: business.id,
      targetBusinessId: business.id,
      // Truthful record of WHAT was revealed without reproducing the secret: the code
      // itself never enters the log, and the phone is masked as everywhere else.
      after: {
        outcome: 'revealed',
        phoneMasked: maskPhone(business.phone),
        expiresInSeconds,
        codeExpiresAt: testCode.expiresAt.toISOString(),
      },
      note: 'Test-account OTP reveal (otp_test_codes); no user OTP hash was read.',
    });

    return { code: testCode.codePlain, expiresInSeconds };
  }

  // --- internals -----------------------------------------------------------

  /** Refused attempts are audit-logged too: an attempt on a non-test id is security-relevant. */
  private async recordRefusal(
    actor: AdminPrincipal,
    businessId: string,
    reason: RevealRefusal,
    targetBusinessId: string | null,
  ): Promise<void> {
    await this.audit.record(actor, {
      actionType: 'reveal-otp',
      action: `${actor.name} attempted an OTP reveal for business ${businessId} and was refused`,
      targetType: 'Business',
      targetId: businessId,
      ...(targetBusinessId !== null ? { targetBusinessId } : {}),
      after: { outcome: 'refused', reason },
      note: 'No code was returned.',
    });
  }
}

/** Phones are masked server-side before they reach the audit log, as everywhere else. */
function maskPhone(phone: string): string {
  if (phone.length <= 4) return '*'.repeat(phone.length);
  return `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
}
