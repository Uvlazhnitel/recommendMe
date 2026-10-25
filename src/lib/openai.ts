class OpenAIError extends Error {}
export const MAX_OUTPUT_TOKENS = 12000;
export const OPENAI_TIMEOUT_MS = 180000;
export type Usage = { input_tokens: number | null; output_tokens: number | null };
export type OpenAIResult = { body: unknown; model: string; response_id: string | null; usage: Usage | null };
export function requireOpenAIConfig(apiKey?: string, model?: string) {
  if (!apiKey?.trim()) throw new OpenAIError('OPENAI_API_KEY is not configured in the server environment.');
  if (!model?.trim()) throw new OpenAIError('OPENAI_MODEL is not configured; choose a Structured Outputs model explicitly.');
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OpenAIError('Invalid OpenAI response object.');
  return value as Record<string, unknown>;
}
function tokenCount(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new OpenAIError('Invalid OpenAI usage.');
  return value;
}
export function parseUsage(value: unknown): Usage | null {
  if (value === undefined || value === null) return null;
  const usage = record(value);
  return { input_tokens: tokenCount(usage.input_tokens), output_tokens: tokenCount(usage.output_tokens) };
}
export type OpenAIOptions = { apiKey?: string; model?: string; fetch?: typeof fetch; timeoutMs?: number };
export type StructuredRequest = { input: { role: string; content: string }[]; format: unknown; maxInputBytes: number };
export async function requestStructuredOutput(request: StructuredRequest, options: OpenAIOptions): Promise<OpenAIResult> {
  requireOpenAIConfig(options.apiKey, options.model);
  const text = { format: request.format };
  if (Buffer.byteLength(JSON.stringify({ input: request.input, text }), 'utf8') > request.maxInputBytes) throw new OpenAIError('OpenAI input exceeds the configured byte limit.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? OPENAI_TIMEOUT_MS);
  try {
    const response = await (options.fetch ?? fetch)('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: `Bearer ${options.apiKey!.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: options.model!.trim(), input: request.input, text, store: false, max_output_tokens: MAX_OUTPUT_TOKENS }),
      signal: controller.signal, redirect: 'error', cache: 'no-store',
    });
    if (!response.ok) throw new OpenAIError(`OpenAI HTTP ${response.status}; check API credentials, model access and account limits. No automatic retry was made.`);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new OpenAIError('OpenAI returned invalid JSON. No automatic retry was made.'); }
    const result = record(payload);
    if (result.status !== 'completed') throw new OpenAIError('OpenAI response is incomplete or unsuccessful.');
    if (typeof result.model !== 'string' || !result.model.trim()) throw new OpenAIError('OpenAI response is missing its model.');
    if (!Array.isArray(result.output)) throw new OpenAIError('OpenAI response has no structured output.');
    const texts: string[] = [];
    for (const value of result.output) {
      const item = record(value);
      if (item.type === 'reasoning') continue; // Never persist or print reasoning output.
      if (item.type !== 'message' || (item.status !== undefined && item.status !== 'completed') || !Array.isArray(item.content)) throw new OpenAIError('Unexpected OpenAI output item.');
      for (const value of item.content) {
        const content = record(value);
        if (content.type === 'refusal') throw new OpenAIError('OpenAI refused the request.');
        if (content.type !== 'output_text' || typeof content.text !== 'string') throw new OpenAIError('OpenAI returned unsupported output content.');
        texts.push(content.text);
      }
    }
    if (!texts.length) throw new OpenAIError('OpenAI returned no structured text.');
    let body: unknown;
    try { body = JSON.parse(texts.join('')); } catch { throw new OpenAIError('OpenAI output text is not valid JSON.'); }
    return { body, model: result.model, response_id: typeof result.id === 'string' ? result.id : null, usage: parseUsage(result.usage) };
  } catch (error) {
    if (controller.signal.aborted) throw new OpenAIError('OpenAI request timed out; it may already have been billed. No automatic retry was made.');
    // Only our own errors are exposed; network exceptions can contain credentials or private payloads.
    if (error instanceof OpenAIError) throw error;
    throw new OpenAIError('OpenAI network/request failure; no automatic retry was made.');
  } finally { clearTimeout(timer); }
}
