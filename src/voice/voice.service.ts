import { Inject, Injectable } from '@nestjs/common';
import { LLM_PROVIDER, LlmProvider, VoiceParseOutput } from '@common';
import { VoiceParseDto } from '@shared';
import { CREDIT_WEIGHTS, CreditLedgerService } from '../usage/credit-ledger.service';

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
  ) {}

  async parse(businessId: string, dto: VoiceParseDto): Promise<VoiceParseOutput> {
    const parsed = await this.llm.parseVoiceDebt({
      transcript: dto.transcript,
      knownCustomers: dto.knownCustomers,
    });

    // Debit only AFTER a successful parse. Exhausted credits throw PLAN_REQUIRED (403);
    // the exception propagates before any parsed data leaks back to the caller.
    await this.credits.debitCredits(businessId, CREDIT_WEIGHTS.voiceParse, 'voice-parse');

    return parsed;
  }
}
