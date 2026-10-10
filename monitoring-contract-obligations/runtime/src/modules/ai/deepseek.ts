export type ExtractedObligation = Readonly<{
  title: string;
  description?: string | null;
  responsibleParty?: string | null;
  dueDate?: string | null;
  obligationType: 'financial' | 'non_financial';
  sanction?: string | null;
  riskLevel?: string | null;
  confidence?: number | null;
  sourceFragment?: string | null;
  amount?: number | null;
  currency?: string | null;
}>;

type DeepSeekConfig = Readonly<{
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  maxOutputTokens?: number;
}>;

type DeepSeekResponse = Readonly<{
  choices?: Array<{ message?: { content?: string } }>;
}>;

function parseJsonContent(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(trimmed);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeObligations(value: unknown): ExtractedObligation[] {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { obligations?: unknown }).obligations
    : value;
  if (!Array.isArray(source)) throw new Error('DeepSeek returned JSON without obligations array.');
  return source.flatMap((item): ExtractedObligation[] => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const title = asString(row.title) ?? asString(row.subject);
    if (!title) return [];
    const type = row.obligation_type ?? row.obligationType ?? row.type;
    return [{
      title,
      description: asString(row.description),
      responsibleParty: asString(row.responsible_party ?? row.responsibleParty),
      dueDate: asString(row.due_date ?? row.dueDate),
      obligationType: type === 'financial' ? 'financial' : 'non_financial',
      sanction: asString(row.sanction),
      riskLevel: asString(row.risk_level ?? row.riskLevel),
      confidence: asNumber(row.confidence),
      sourceFragment: asString(row.source_fragment ?? row.sourceFragment),
      amount: asNumber(row.amount),
      currency: asString(row.currency),
    }];
  });
}

export function parseDeepSeekContent(content: string): ExtractedObligation[] {
  return normalizeObligations(parseJsonContent(content));
}

export function createDeepSeekExtractor(config: DeepSeekConfig = {}) {
  const apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY;
  const baseUrl = (config.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, '');
  const model = config.model ?? process.env.DEEPSEEK_EXTRACTION_MODEL ?? process.env.DEEPSEEK_PLANNING_MODEL ?? 'deepseek-chat';
  const timeoutMs = config.timeoutMs ?? Number(process.env.AI_PROVIDER_TIMEOUT_MS ?? 120_000);
  const maxRetries = config.maxRetries ?? Number(process.env.AI_PROVIDER_MAX_RETRIES ?? 1);
  const maxOutputTokens = config.maxOutputTokens ?? Number(process.env.AI_MAX_OUTPUT_TOKENS ?? 8_000);

  return {
    model,
    async extract(text: string, context: { contractNumber: string; fileName: string }) {
      if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not configured.');
      if (!text.trim()) throw new Error('Document text is empty.');
      const system = [
        'Ты извлекаешь договорные обязательства из текста договора.',
        'Отвечай только JSON без markdown и дополнительных пояснений.',
        'Извлекай обязанности сторон, но не включай определения, права и общие декларации без действия. Условия ответственности обрабатывай отдельно по следующим правилам.',
        'Гарантийный срок и обязанности по гарантийному сопровождению считай отдельными нефинансовыми обязательствами.',
        'Пени, штрафы и неустойки не теряй: указывай их в поле sanction соответствующего обязательства. Если в тексте есть самостоятельная обязанность уплатить пеню или штраф, создай отдельную финансовую запись с понятным названием и точным source_fragment.',
        'Каждая запись должна содержать title, description, responsible_party, due_date, obligation_type, sanction, risk_level, confidence и source_fragment.',
        'obligation_type может быть только financial или non_financial.',
        'Если срок задан относительно события или в рабочих днях, сохрани формулировку в description, а due_date оставь null.',
        'Не придумывай даты и стороны. Если значение не указано, используй null.',
        'Формат ответа: {"obligations":[{"title":"...","description":"...","responsible_party":"...","due_date":"YYYY-MM-DD или null","obligation_type":"financial или non_financial","sanction":"... или null","risk_level":"low, medium, high или null","confidence":0.0,"source_fragment":"точный фрагмент или null"}]}',
      ].join('\n');
      const user = `Договор ${context.contractNumber}, файл ${context.fileName}.\n\nТекст договора:\n${text}`;
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          const response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model,
              temperature: 0,
              max_tokens: maxOutputTokens,
              response_format: { type: 'json_object' },
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
            }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          const raw = await response.text();
          if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}: ${raw.slice(0, 500)}`);
          const payload = JSON.parse(raw) as DeepSeekResponse;
          const content = payload.choices?.[0]?.message?.content;
          if (!content) throw new Error('DeepSeek response has no message content.');
          const parsed = parseJsonContent(content);
          return { obligations: normalizeObligations(parsed), rawResponse: parsed };
        } catch (error) {
          lastError = error;
          if (attempt < maxRetries) await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
        }
      }
      throw lastError instanceof Error ? lastError : new Error('DeepSeek extraction failed.');
    },
  };
}
