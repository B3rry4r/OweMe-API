import {
  GeminiLlmProvider,
  DEFAULT_GEMINI_MODEL,
} from '../gemini-llm-provider';

/**
 * Contract tests for the real Google Gemini integration.
 * All network I/O is mocked via jest.spyOn(global, 'fetch') — NO real calls.
 *
 * Asserts against the verified generateContent contract:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *   header x-goog-api-key: <key>
 *   body { contents: [{ parts: [{ text }] }], generationConfig: { responseMimeType, responseSchema } }
 *   text at candidates[0].content.parts[0].text
 */

const API_KEY = 'test-gemini-key';
const MODEL = 'gemini-3.5-flash';

function mockFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const status = init.status ?? (init.ok === false ? 400 : 200);
  const ok = init.ok ?? status < 400;
  return jest.spyOn(global, 'fetch').mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Bad Request',
    json: async () => body,
  } as unknown as Response);
}

/** Wrap a JSON string as Gemini would return it in a candidate part. */
function candidate(jsonText: string) {
  return { candidates: [{ content: { parts: [{ text: jsonText }] } }] };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('DEFAULT_GEMINI_MODEL', () => {
  it('is a non-empty string', () => {
    expect(typeof DEFAULT_GEMINI_MODEL).toBe('string');
    expect(DEFAULT_GEMINI_MODEL.length).toBeGreaterThan(0);
  });
});

describe('GeminiLlmProvider.parseVoiceDebt', () => {
  it('POSTs to the verified generateContent URL for the model with the api key and a responseSchema', async () => {
    const spy = mockFetch(
      candidate(
        JSON.stringify({
          customerName: 'Mama Grace',
          amount: 5000,
          description: 'rice',
          dueDate: '2026-07-17',
        }),
      ),
    );

    const provider = new GeminiLlmProvider(API_KEY, MODEL);
    await provider.parseVoiceDebt({
      transcript: 'Mama Grace bought rice for five thousand naira due next Friday',
      knownCustomers: ['Mama Grace', 'Oga Tunde'],
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, opts] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    );
    expect(opts.method).toBe('POST');
    expect((opts.headers as Record<string, string>)['x-goog-api-key']).toBe(API_KEY);

    const payload = JSON.parse(opts.body as string);
    expect(payload.contents[0].parts[0].text).toContain(
      'Mama Grace bought rice for five thousand naira',
    );
    expect(payload.generationConfig.responseMimeType).toBe('application/json');
    expect(payload.generationConfig.responseSchema).toBeDefined();
    expect(payload.generationConfig.responseSchema.properties).toEqual(
      expect.objectContaining({
        customerName: expect.anything(),
        amount: expect.anything(),
        description: expect.anything(),
        dueDate: expect.anything(),
      }),
    );
    // knownCustomers should be threaded into the prompt for matching
    expect(payload.contents[0].parts[0].text).toContain('Oga Tunde');
  });

  it('parses a mocked JSON candidate into VoiceParseOutput with naira->kobo conversion', async () => {
    mockFetch(
      candidate(
        JSON.stringify({
          customerName: 'Mama Grace',
          amount: 5000, // NAIRA
          description: 'rice',
          dueDate: '2026-07-17',
        }),
      ),
    );

    const provider = new GeminiLlmProvider(API_KEY, MODEL);
    const result = await provider.parseVoiceDebt({
      transcript: 'Mama Grace bought rice for five thousand naira due next Friday',
    });

    expect(result).toEqual({
      customerName: 'Mama Grace',
      amount: 500000, // 5000 naira -> 500000 kobo
      description: 'rice',
      dueDate: '2026-07-17',
    });
  });

  it('degrades to zeros/nulls (no throw) on an unparseable-but-successful response', async () => {
    mockFetch(candidate('not-json-at-all'));

    const provider = new GeminiLlmProvider(API_KEY, MODEL);
    const result = await provider.parseVoiceDebt({ transcript: 'garbled audio' });

    expect(result).toEqual({
      customerName: null,
      amount: 0,
      description: null,
      dueDate: null,
    });
  });

  it('returns nulls/zero when the model reports fields it could not determine', async () => {
    mockFetch(
      candidate(
        JSON.stringify({
          customerName: null,
          amount: 0,
          description: null,
          dueDate: null,
        }),
      ),
    );

    const provider = new GeminiLlmProvider(API_KEY, MODEL);
    const result = await provider.parseVoiceDebt({ transcript: 'someone owes something' });

    expect(result).toEqual({
      customerName: null,
      amount: 0,
      description: null,
      dueDate: null,
    });
  });

  it('throws on a non-2xx response', async () => {
    mockFetch({ error: { message: 'API key not valid' } }, { ok: false, status: 400 });

    const provider = new GeminiLlmProvider(API_KEY, MODEL);
    await expect(
      provider.parseVoiceDebt({ transcript: 'Mama Grace owes 5000' }),
    ).rejects.toThrow(/Gemini generateContent failed/);
  });
});

describe('GeminiLlmProvider insights/risk (v1 not wired)', () => {
  it('generateInsights throws an explicit not-wired error', async () => {
    const provider = new GeminiLlmProvider(API_KEY, MODEL);
    await expect(provider.generateInsights('biz-1')).rejects.toThrow(
      /aggregation pipeline not wired/,
    );
  });

  it('scoreCustomerRisk throws an explicit not-wired error', async () => {
    const provider = new GeminiLlmProvider(API_KEY, MODEL);
    await expect(provider.scoreCustomerRisk('biz-1', 'cust-1')).rejects.toThrow(
      /aggregation pipeline not wired/,
    );
  });
});
