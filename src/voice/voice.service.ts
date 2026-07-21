import { Inject, Injectable } from '@nestjs/common';
import { LLM_PROVIDER, LlmProvider, VoiceParseOutput } from '@common';
import { VoiceParseDto } from '@shared';
import { CREDIT_WEIGHTS, CreditLedgerService } from '../usage/credit-ledger.service';
import { UsageEventRecorder } from '../usage/usage-event.recorder';

/**
 * VoiceService — transcript-only debt parsing (record-debt screen).
 *
 * Flow (conventions §AI, debit-on-success ONLY): parse the transcript via the injected
 * LlmProvider (never call an LLM directly), and ONLY after a successful parse debit
 * CREDIT_WEIGHTS.voiceParse credits ('voice-parse') through the shared CreditLedgerService. If the ledger is
 * exhausted it throws PLAN_REQUIRED (-> 403) and no parsed data is returned.
 */
@Injectable()
export class VoiceService {
  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly credits: CreditLedgerService,
    private readonly usageEvents: UsageEventRecorder,
  ) {}

  async parse(businessId: string, dto: VoiceParseDto): Promise<VoiceParseOutput> {
    const parsed = await this.llm.parseVoiceDebt({
      transcript: dto.transcript,
      knownCustomers: dto.knownCustomers,
    });

    // Debit only AFTER a successful parse. Exhausted credits throw PLAN_REQUIRED (403);
    // the exception propagates before any parsed data leaks back to the caller.
    await this.credits.debitCredits(businessId, CREDIT_WEIGHTS.voiceParse, 'voice-parse');

    // Instrumentation (best-effort, never fails the parse). METADATA ONLY: the transcript and
    // the parsed fields NEVER enter meta. No per-call LLM price is exposed by the provider
    // seam, so costKoboEstimate stays null rather than inventing a number.
    await this.usageEvents.record({
      businessId,
      type: 'voiceParse',
      credits: CREDIT_WEIGHTS.voiceParse,
      costKoboEstimate: null,
      meta: { outcome: 'success' },
    });

    return parsed;
  }
}
