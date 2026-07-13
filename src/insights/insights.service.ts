import { Injectable, NotImplementedException } from '@nestjs/common';

/**
 * InsightsService — AI-generated dashboard insights (owner surface).
 *
 * Contract (registry: Insights, wave 3): GET /insights/dashboard is a **501 scaffold**.
 * The screens that render it are stubs, so no live path ships yet. Authentication + the
 * owner role are still enforced upstream (JwtAuthGuard + RolesGuard); only the handler body
 * is unimplemented.
 */
@Injectable()
export class InsightsService {
  /**
   * 501 scaffold. Throws NotImplementedException, which the global HttpExceptionFilter
   * renders as the shared ErrorEnvelope (code INTERNAL, HTTP 501).
   *
   * TODO(live impl — do NOT wire until the insights screens ship):
   *   1. Verify AI credits are available for `businessId` (fail-closed to PLAN_REQUIRED when out).
   *   2. Call the LLM behind the LlmProvider interface, e.g.
   *      `@Inject(LLM_PROVIDER) private readonly llm: LlmProvider` -> `llm.generateInsights(businessId)`.
   *   3. On SUCCESS ONLY, debit 5 AI credits via CreditLedgerService.debitCredits(businessId, 5, 'insight')
   *      (weighted insight = 5, debit-on-success per conventions §Metering).
   *   4. Return `{ insights: <object> }`.
   * Wiring requires importing UsageModule (CreditLedgerService) + LLM_PROVIDER from @common;
   * intentionally left unwired now so no credits are ever debited by the scaffold.
   */
  getDashboard(_businessId: string): never {
    throw new NotImplementedException('AI insights dashboard is not implemented yet');
  }
}
