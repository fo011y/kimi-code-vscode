/**
 * Минимальный клиент OpenAI-совместимого API Moonshot (Kimi)
 * с потоковой передачей (SSE) и поддержкой tool calling.
 */

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: ToolCallFunction;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ApiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: TokenUsage;
}

/** Встроенный список моделей на случай, если API недоступен. */
export const FALLBACK_MODELS = [
  'kimi-k2-0905-preview',
  'kimi-k2-turbo-preview',
  'kimi-latest',
  'kimi-thinking-preview',
  'moonshot-v1-8k',
  'moonshot-v1-32k',
  'moonshot-v1-128k',
];

/** Получить список доступных моделей с API (GET /models). */
export async function listModels(cfg: ApiConfig): Promise<string[]> {
  const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/models`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Moonshot API ${res.status}`);
  }
  const json: any = await res.json();
  const ids: string[] = (json?.data ?? [])
    .map((m: any) => String(m?.id ?? ''))
    .filter(Boolean);
  return ids.length > 0 ? ids.sort() : FALLBACK_MODELS;
}

/** Оценка размера контекстного окна по имени модели (k3-256k → 256k). */
export function contextWindowForModel(model: string): number {
  const m = /(\d+)\s*k(?![a-z])/i.exec(model);
  if (m) return parseInt(m[1], 10) * 1024;
  return 128 * 1024; // дефолт — 128k
}

export interface BalanceInfo {
  available: number;
  voucher: number;
  cash: number;
}

/**
 * Баланс открытой платформы Moonshot (GET /users/me/balance).
 * Работает только для API-ключа platform.moonshot.*; при ошибке — undefined.
 */
export async function fetchBalance(baseUrl: string, apiKey: string): Promise<BalanceInfo | undefined> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/users/me/balance`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return undefined;
    const json: any = await res.json();
    const d = json?.data;
    if (!d || typeof d !== 'object') return undefined;
    return {
      available: Number(d.available_balance ?? 0),
      voucher: Number(d.voucher_balance ?? 0),
      cash: Number(d.cash_balance ?? 0),
    };
  } catch {
    return undefined;
  }
}

export async function streamChat(
  cfg: ApiConfig,
  messages: ChatMessage[],
  opts: {
    tools?: ToolDef[];
    onToken?: (text: string) => void;
    signal?: AbortSignal;
  } = {}
): Promise<ChatResult> {
  // Управляемый endpoint подписки Kimi Code (OAuth) принимает только
  // temperature=1 — не отправляем параметр вовсе, сервер применит свой дефолт.
  const isManaged = /\/\/api\.kimi\.(com|ai)\/coding\//.test(cfg.baseUrl);
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    max_tokens: cfg.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (!isManaged) body.temperature = cfg.temperature;
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = 'auto';
  }

  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Moonshot API ${res.status}: ${text.slice(0, 500)}`);
  }
  if (!res.body) {
    throw new Error('Пустой ответ API');
  }

  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let finishReason = '';
  let usage: TokenUsage | undefined;
  const toolCalls: ToolCall[] = [];

  const handleLine = (line: string) => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const data = t.slice(5).trim();
    if (data === '[DONE]') return;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    if (json.error) {
      throw new Error(`Moonshot API: ${json.error.message ?? JSON.stringify(json.error)}`);
    }
    if (json.usage && typeof json.usage.total_tokens === 'number') {
      usage = {
        prompt_tokens: json.usage.prompt_tokens ?? 0,
        completion_tokens: json.usage.completion_tokens ?? 0,
        total_tokens: json.usage.total_tokens,
      };
    }
    const choice = json.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      opts.onToken?.(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const i: number = tc.index ?? 0;
      if (!toolCalls[i]) {
        toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
      }
      if (tc.id) toolCalls[i].id = tc.id;
      if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
      if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
    }
  };

  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) handleLine(buf);

  return { content, toolCalls: toolCalls.filter(Boolean), finishReason, usage };
}
