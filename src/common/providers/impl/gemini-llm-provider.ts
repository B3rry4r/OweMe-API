import type {
  LlmProvider,
  VoiceParseInput,
  VoiceParseOutput,
} from '../llm-provider';

/**
 * Real Google Gemini implementation of the FROZEN LlmProvider interface.
 *
 * Docs verified against Google's official Gemini API reference (2026-07):
 *  - Model list:        https://ai.google.dev/gemini-api/docs/models
 *  - Text generation:   https://ai.google.dev/gemini-api/docs/text-generation
 *  - Structured output: https://ai.google.dev/gemini-api/docs/structured-output
 *  - generateContent:   https://ai.google.dev/api/generate-content
 *
 * MODEL CHOICE — `gemini-3.5-flash`:
 *   The product owner was unsure whether the Flash model was "3.5 or 3.0". Resolved from the
 *   live model list (https://ai.google.dev/gemini-api/docs/models): the CURRENT recommended
 *   STABLE Flash model is `gemini-3.5-flash`. Older Flash ids (gemini-2.0-flash) are deprecated /
 *   being shut down, and gemini-3.1-flash-lite is the lighter tier. We pick the standard stable
 *   Flash — `gemini-3.5-flash` — for the best price/latency/quality balance on this extraction task.
 *
 * ENDPOINT / AUTH (verified https://ai.google.dev/api/generate-content):
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *   The API key is sent in the request HEADER `x-goog-api-key: <key>` — the currently
 *   recommended method (also shown in the official text-generation curl example). (The legacy
 *   `?key=<key>` query form still works but the header is preferred and keeps the key out of URLs.)
 *
 * STRUCTURED OUTPUT (verified https://ai.google.dev/gemini-api/docs/structured-output):
 *   Set `generationConfig.responseMimeType = "application/json"` and provide a
 *   `generationConfig.responseSchema` (an OpenAPI-subset schema; camelCase field names). Gemini
 *   then constrains output to syntactically-valid JSON matching the schema.
 *
 * RESPONSE SHAPE (verified https://ai.google.dev/api/generate-content):
 *   The generated text lives at `candidates[0].content.parts[0].text`.
 *
 * Uses Node's global `fetch` (Node 22) — no extra npm deps. Plain class (no Nest decorators);
 * the dispatcher constructs it with the api key + model and binds it to the LLM_PROVIDER token.
 */

/**
 * Default Gemini model id. The dispatcher supplies `model` from env `GEMINI_MODEL` and falls
 * back to this constant. Kept as the current stable Flash id verified from the live docs.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Shape Gemini is instructed to emit for a parsed voice debt note. `amount` is in NAIRA. */
interface GeminiVoiceParse {
  customerName: string | null;
  amount: number | null;
  description: string | null;
  dueDate: string | null;
}

export class GeminiLlmProvider implements LlmProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  /**
   * Parse a spoken debt note (Nigerian small-business context, e.g.
   * "Mama Grace bought rice for five thousand naira due next Friday") into a structured object.
   *
   * Uses structured output (responseMimeType application/json + responseSchema). The model is
   * asked to return the amount in NAIRA; we convert naira -> KOBO (x100, integer) here because
   * `VoiceParseOutput.amount` is kobo. Fields the model cannot determine come back as null.
   * Never throws on an unparseable-but-successful (2xx) response — it degrades to zeros/nulls.
   * Throws only on a non-2xx / blocked response (no candidate returned).
   */
  async parseVoiceDebt(input: VoiceParseInput): Promise<VoiceParseOutput> {
    const knownCustomers = input.knownCustomers ?? [];
    const matchInstruction =
      knownCustomers.length > 0
        ? `If the customer named in the note matches one of these known customers (case-insensitive, tolerate minor spelling/spacing differences), return that customer's exact spelling: ${JSON.stringify(
            knownCustomers,
          )}. Otherwise return the name as spoken, or null if no customer is named.`
        : 'Return the customer name as spoken, or null if no customer is named.';

    const prompt = [
      'You extract a structured debt record from a short spoken note by a Nigerian small-business owner.',
      'The note records that a customer owes the business money (credit sale / debt).',
      matchInstruction,
      'Return the amount as a NUMBER in NAIRA (the major currency unit). Convert spoken words to digits: "five thousand naira" -> 5000, "2k" -> 2000. If no amount is stated, return 0.',
      'Return description as a short phrase of what was bought/owed, or null.',
      'Return dueDate as an ISO 8601 date string (YYYY-MM-DD) if a due date is stated or clearly implied (e.g. "next Friday"), otherwise null.',
      '',
      `Voice note transcript: "${input.transcript}"`,
    ].join('\n');

    // responseSchema mirrors VoiceParseOutput (but amount is NAIRA here). Uppercase OpenAPI
    // types per the structured-output docs. `nullable` lets fields be omitted/null.
    const responseSchema = {
      type: 'OBJECT',
      properties: {
        customerName: { type: 'STRING', nullable: true },
        amount: { type: 'NUMBER', nullable: true },
        description: { type: 'STRING', nullable: true },
        dueDate: { type: 'STRING', nullable: true },
      },
      required: ['customerName', 'amount', 'description', 'dueDate'],
    };

    const text = await this.generateContent(prompt, {
      responseMimeType: 'application/json',
      responseSchema,
      temperature: 0,
    });

    const parsed = safeParse(text);

    // naira -> kobo (x100, integer). Guard against non-finite / negative model output.
    const naira =
      typeof parsed.amount === 'number' && Number.isFinite(parsed.amount) && parsed.amount > 0
        ? parsed.amount
        : 0;
    const amountKobo = Math.round(naira * 100);

    return {
      customerName: nonEmptyString(parsed.customerName),
      amount: amountKobo,
      description: nonEmptyString(parsed.description),
      dueDate: nonEmptyString(parsed.dueDate),
    };
  }

  /**
   * NOT IMPLEMENTED in v1. Insights require aggregating this business's debts/payments/customers
   * and feeding that context to the model — this provider has no DB access, so it cannot produce
   * honest insights. Wiring a business-data aggregation pipeline into this call is a separate task.
   * We throw explicitly rather than invent fake numbers.
   */
  async generateInsights(_businessId: string): Promise<Record<string, unknown>> {
    throw new Error('insights/risk require an aggregation pipeline not wired in v1');
  }

  /**
   * NOT IMPLEMENTED in v1. Risk scoring needs the customer's payment history / debt ledger, which
   * this provider cannot read (no DB access). Wiring that aggregation in is a separate task.
   * We throw explicitly rather than invent a fake score.
   */
  async scoreCustomerRisk(
    _businessId: string,
    _customerId: string,
  ): Promise<{ score: number; band: string }> {
    throw new Error('insights/risk require an aggregation pipeline not wired in v1');
  }

  /**
   * Issue a generateContent request and return the text from the first candidate.
   * Throws a clear Error on non-2xx HTTP or when the response carries no candidate text
   * (e.g. prompt blocked by safety filters).
   */
  private async generateContent(
    prompt: string,
    generationConfig: Record<string, unknown>,
  ): Promise<string> {
    const url = `${GEMINI_BASE_URL}/models/${this.model}:generateContent`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig,
      }),
    });

    let payload: GeminiResponse | null = null;
    try {
      payload = (await res.json()) as GeminiResponse;
    } catch {
      payload = null;
    }

    if (!res.ok) {
      const msg = payload?.error?.message ?? res.statusText;
      throw new Error(`Gemini generateContent failed (HTTP ${res.status}): ${msg}`);
    }

    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string' || text.length === 0) {
      const reason =
        payload?.promptFeedback?.blockReason ??
        payload?.candidates?.[0]?.finishReason ??
        'no candidate text returned';
      throw new Error(`Gemini generateContent returned no usable content: ${reason}`);
    }
    return text;
  }
}

/** Minimal typing of the generateContent response fields we read. */
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

/** Parse JSON text into a partial GeminiVoiceParse; never throws — returns empty on bad input. */
function safeParse(text: string): Partial<GeminiVoiceParse> {
  try {
    const obj = JSON.parse(text) as unknown;
    if (obj && typeof obj === 'object') return obj as Partial<GeminiVoiceParse>;
  } catch {
    /* fall through */
  }
  return {};
}

/** Coerce to a trimmed non-empty string, else null. */
function nonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}
