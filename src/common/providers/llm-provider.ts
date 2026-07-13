import { Injectable } from '@nestjs/common';

export interface VoiceParseInput {
  transcript: string;
  knownCustomers?: string[];
}

export interface VoiceParseOutput {
  customerName: string | null;
  amount: number; // kobo
  description: string | null;
  dueDate: string | null;
}

/** LlmProvider — voice parse / insights / risk. FROZEN interface. Debit-on-success is the caller's job. */
export interface LlmProvider {
  parseVoiceDebt(input: VoiceParseInput): Promise<VoiceParseOutput>;
  generateInsights(businessId: string): Promise<Record<string, unknown>>;
  scoreCustomerRisk(businessId: string, customerId: string): Promise<{ score: number; band: string }>;
}

/** Default stub — returns deterministic fixtures (no external LLM calls). */
@Injectable()
export class StubLlmProvider implements LlmProvider {
  async parseVoiceDebt(_input: VoiceParseInput): Promise<VoiceParseOutput> {
    return { customerName: null, amount: 0, description: null, dueDate: null };
  }

  async generateInsights(_businessId: string): Promise<Record<string, unknown>> {
    return {};
  }

  async scoreCustomerRisk(
    _businessId: string,
    _customerId: string,
  ): Promise<{ score: number; band: string }> {
    return { score: 0, band: 'unknown' };
  }
}
