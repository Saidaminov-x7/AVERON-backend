import { config } from '../../config';
import { randomUUID } from 'node:crypto';
import { createGeminiBudget } from './gemini-budget';
import type { Redis } from 'ioredis';

export interface GeminiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const GEMINI_CHAT_COMPLETIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const MAX_OUTPUT_TOKENS = 1024;
const MAX_OUTPUT_CHARS = 12_000;
const MAX_STREAM_BYTES = 256 * 1024;
const MAX_COMPLETION_BYTES = 256 * 1024;
const MAX_INPUT_MESSAGES = 22;
const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_TOTAL_INPUT_BYTES = 40 * 1024;

/** Accept only chat roles and bound UTF-8 bytes before any external request. */
export function sanitizeGeminiMessages(input: unknown): GeminiMessage[] {
  if (!Array.isArray(input)) return [];
  const safe = input.filter((item): item is GeminiMessage =>
    Boolean(item) && typeof item === 'object' &&
    ['system', 'user', 'assistant'].includes((item as GeminiMessage).role) &&
    typeof (item as GeminiMessage).content === 'string',
  ).slice(-MAX_INPUT_MESSAGES);

  let totalBytes = 0;
  const result: GeminiMessage[] = [];
  const system = safe.find((item) => item.role === 'system');
  const turns = safe.filter((item) => item.role !== 'system');
  const prioritized = [...(system ? [system] : []), ...turns.reverse()];
  for (const item of prioritized) {
    const remaining = Math.min(MAX_MESSAGE_BYTES, MAX_TOTAL_INPUT_BYTES - totalBytes);
    if (remaining <= 0) break;
    const content = truncateUtf8(item.content.trim(), remaining);
    if (!content) continue;
    totalBytes += new TextEncoder().encode(content).byteLength;
    result.push({ role: item.role, content });
  }
  const first = system && result[0]?.role === 'system' ? result.shift() : undefined;
  result.reverse();
  return first ? [first, ...result] : result;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let output = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = new TextEncoder().encode(character).byteLength;
    if (bytes + characterBytes > maximumBytes) break;
    output += character;
    bytes += characterBytes;
  }
  return output;
}

function assertEnabled() {
  if (!config.FEATURE_GEMINI_CHAT || !config.GEMINI_API_KEY) {
    throw Object.assign(new Error('Gemini chat is disabled'), { statusCode: 503 });
  }
}

export function buildGeminiPayload(messages: GeminiMessage[], stream: boolean) {
  return {
    model: config.GEMINI_CHAT_MODEL,
    messages: sanitizeGeminiMessages(messages),
    stream,
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0.5,
  };
}

export async function completeWithGemini(messages: GeminiMessage[], userId: string, redis: Redis): Promise<string> {
  assertEnabled();
  const safeMessages = sanitizeGeminiMessages(messages);
  const ledger = createGeminiBudget(redis, config.GEMINI_CHAT_MODEL);
  const estimate = new TextEncoder().encode(JSON.stringify(safeMessages)).byteLength;
  const reservation = await ledger.reserveGeminiBudget({
    userId,
    requestId: randomUUID(),
    estimatedInputTokens: estimate,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  if (!reservation) throw Object.assign(new Error('AI budget unavailable'), { statusCode: 503 });
  try {
    const response = await fetch(GEMINI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.GEMINI_API_KEY}`,
      },
      body: JSON.stringify(buildGeminiPayload(safeMessages, false)),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error('Gemini request failed');
    if (!response.body) throw new Error('Gemini response is empty');
    const result = JSON.parse(await readBoundedBody(response.body, MAX_COMPLETION_BYTES)) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('Gemini returned no content');
    const usage = result.usage;
    if (Number.isSafeInteger(usage?.prompt_tokens) && Number.isSafeInteger(usage?.completion_tokens)) {
      await ledger.settleGeminiBudget({
        reservationId: reservation.reservationId,
        actualInputTokens: usage!.prompt_tokens!,
        actualOutputTokens: usage!.completion_tokens!,
      }).catch(() => {});
    }
    return content.slice(0, MAX_OUTPUT_CHARS);
  } catch {
    throw Object.assign(new Error('AI-сервис временно недоступен. Пожалуйста, повторите попытку позже.'), { statusCode: 503 });
  }
}

async function readBoundedBody(body: ReadableStream<Uint8Array>, maximumBytes: number): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) throw new Error('Gemini response exceeded limit');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** Parses OpenAI-compatible SSE while preserving events split across network chunks. */
export async function* streamGemini(messages: GeminiMessage[], userId: string, redis: Redis, signal?: AbortSignal): AsyncGenerator<string> {
  assertEnabled();
  const safeMessages = sanitizeGeminiMessages(messages);
  const ledger = createGeminiBudget(redis, config.GEMINI_CHAT_MODEL);
  const estimate = new TextEncoder().encode(JSON.stringify(safeMessages)).byteLength;
  const reservation = await ledger.reserveGeminiBudget({
    userId,
    requestId: randomUUID(),
    estimatedInputTokens: estimate,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  if (!reservation) throw Object.assign(new Error('AI budget unavailable'), { statusCode: 503 });
  let response: Response;
  try {
    response = await fetch(GEMINI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.GEMINI_API_KEY}`,
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ ...buildGeminiPayload(safeMessages, true), stream_options: { include_usage: true } }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    });
    if (!response.ok || !response.body) throw new Error('Gemini stream unavailable');
  } catch {
    throw Object.assign(new Error('AI-сервис временно недоступен. Пожалуйста, повторите попытку позже.'), { statusCode: 503 });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let fullResponse = '';
  let bytesRead = 0;
  let ended = false;
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

  try {
    while (!ended) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_STREAM_BYTES) throw new Error('Gemini stream exceeded limit');
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const event = parseSseLine(line);
        if (event === null) { ended = true; break; }
        if (!event) continue;
        usage = event.usage ?? usage;
        const chunk = event.content;
        if (!chunk) continue;
        const remaining = MAX_OUTPUT_CHARS - fullResponse.length;
        if (remaining <= 0) { ended = true; break; }
        const bounded = chunk.slice(0, remaining);
        fullResponse += bounded;
        if (bounded) yield bounded;
      }
    }
    if (pending && !ended) {
      const event = parseSseLine(pending);
      if (event) {
        usage = event.usage ?? usage;
        const chunk = event.content ?? '';
        if (chunk && fullResponse.length < MAX_OUTPUT_CHARS) {
        const bounded = chunk.slice(0, MAX_OUTPUT_CHARS - fullResponse.length);
        fullResponse += bounded;
        if (bounded) yield bounded;
        }
      }
    }
    if (Number.isSafeInteger(usage?.prompt_tokens) && Number.isSafeInteger(usage?.completion_tokens)) {
      await ledger.settleGeminiBudget({
        reservationId: reservation.reservationId,
        actualInputTokens: usage!.prompt_tokens!,
        actualOutputTokens: usage!.completion_tokens!,
      }).catch(() => {});
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function parseSseLine(line: string): { content?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } } | null | undefined {
  if (!line.startsWith('data:')) return undefined;
  const data = line.slice(5).trim();
  if (data === '[DONE]') return null;
  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: unknown } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = parsed.choices?.[0]?.delta?.content;
    return {
      ...(typeof content === 'string' ? { content } : {}),
      ...(parsed.usage ? { usage: parsed.usage } : {}),
    };
  } catch {
    return undefined;
  }
}
