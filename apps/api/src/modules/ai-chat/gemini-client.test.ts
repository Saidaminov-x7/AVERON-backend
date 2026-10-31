import { afterEach, describe, expect, it, vi } from 'vitest';

const { geminiConfig, budgetMocks } = vi.hoisted(() => ({
  geminiConfig: {
    FEATURE_GEMINI_CHAT: false,
    GEMINI_API_KEY: undefined as string | undefined,
    GEMINI_CHAT_MODEL: 'server-model',
  },
  budgetMocks: {
    reserve: vi.fn(async (): Promise<{ reservationId: string } | null> => ({ reservationId: 'mock-reservation' })),
    settle: vi.fn(async () => {}),
  },
}));
vi.mock('../../config', () => ({ config: geminiConfig }));
vi.mock('./gemini-budget', () => ({
  createGeminiBudget: vi.fn(() => ({ reserveGeminiBudget: budgetMocks.reserve, settleGeminiBudget: budgetMocks.settle })),
}));

import { buildGeminiPayload, completeWithGemini, sanitizeGeminiMessages, streamGemini } from './gemini-client';
import type { Redis } from 'ioredis';
const fakeRedis = {} as Redis;

afterEach(() => {
  vi.unstubAllGlobals();
  geminiConfig.FEATURE_GEMINI_CHAT = false;
  geminiConfig.GEMINI_API_KEY = undefined;
  budgetMocks.reserve.mockReset().mockResolvedValue({ reservationId: 'mock-reservation' });
  budgetMocks.settle.mockReset().mockResolvedValue(undefined);
});

describe('Gemini chat adapter', () => {
  it('preserves the latest user message when history exceeds the aggregate limit', () => {
    const messages = sanitizeGeminiMessages([
      { role: 'system', content: 'instructions' },
      ...Array.from({ length: 20 }, () => ({ role: 'assistant', content: 'x'.repeat(8000) })),
      { role: 'user', content: 'latest request' },
    ]);
    expect(messages[0]).toEqual({ role: 'system', content: 'instructions' });
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'latest request' });
  });
  it('rejects untrusted roles and enforces message, UTF-8 byte, and aggregate caps', () => {
    const counted = sanitizeGeminiMessages([
      { role: 'system', content: 'should-not-be-forwarded' },
      ...Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'short' })),
      { role: 'tool', content: 'injected tool call' },
    ]);
    expect(counted).toHaveLength(22);
    expect(counted.every(({ role }) => role === 'user' || role === 'assistant' || role === 'system')).toBe(true);

    const bounded = sanitizeGeminiMessages(Array.from({ length: 22 }, (_, index) => ({
      role: index === 0 ? 'system' : 'user', content: 'я'.repeat(5000),
    })));
    expect(bounded.every(({ content }) => new TextEncoder().encode(content).byteLength <= 8 * 1024)).toBe(true);
    expect(bounded.reduce((sum, { content }) => sum + new TextEncoder().encode(content).byteLength, 0)).toBeLessThanOrEqual(40 * 1024);
  });

  it('uses the server model, never a caller model, and bounds generated output', async () => {
    geminiConfig.FEATURE_GEMINI_CHAT = true;
    geminiConfig.GEMINI_API_KEY = 'mock-server-key';
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ choices: [{ message: { content: 'x'.repeat(13_000) } }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await completeWithGemini([{ role: 'user', content: 'hi' }], 'user-1', fakeRedis);
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(fetchMock.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(request.model).toBe('server-model');
    expect(request.max_tokens).toBe(1024);
    expect(request.model).not.toBe('client-controlled-model');
    expect(result).toHaveLength(12_000);
  });

  it('does not fetch while disabled or when the server key is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(completeWithGemini([{ role: 'user', content: 'hi' }], 'user-1', fakeRedis)).rejects.toMatchObject({ statusCode: 503 });
    geminiConfig.FEATURE_GEMINI_CHAT = true;
    await expect(completeWithGemini([{ role: 'user', content: 'hi' }], 'user-1', fakeRedis)).rejects.toMatchObject({ statusCode: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when the atomic budget reservation is unavailable', async () => {
    geminiConfig.FEATURE_GEMINI_CHAT = true;
    geminiConfig.GEMINI_API_KEY = 'mock-server-key';
    budgetMocks.reserve.mockResolvedValueOnce(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(completeWithGemini([{ role: 'user', content: 'hi' }], 'user-1', fakeRedis)).rejects.toMatchObject({ statusCode: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves SSE deltas split across transport chunks and stops at DONE', async () => {
    geminiConfig.FEATURE_GEMINI_CHAT = true;
    geminiConfig.GEMINI_API_KEY = 'mock-server-key';
    const encoded = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Привет"}}]}\n\ndata: [DONE]\n\n');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 17));
        controller.enqueue(encoded.slice(17, 39));
        controller.enqueue(encoded.slice(39));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    const chunks: string[] = [];
    for await (const chunk of streamGemini([{ role: 'user', content: 'hi' }], 'user-1', fakeRedis)) chunks.push(chunk);
    expect(chunks.join('')).toBe('Привет');
  });

  it('cancels the upstream stream when the consumer disconnects', async () => {
    geminiConfig.FEATURE_GEMINI_CHAT = true;
    geminiConfig.GEMINI_API_KEY = 'mock-server-key';
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
      },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    const stream = streamGemini([{ role: 'user', content: 'hi' }], 'user-1', fakeRedis);
    expect((await stream.next()).value).toBe('hello');
    await stream.return(undefined);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds streamed output and returns sanitized provider errors on timeout', async () => {
    geminiConfig.FEATURE_GEMINI_CHAT = true;
    geminiConfig.GEMINI_API_KEY = 'mock-server-key';
    const data = `data: ${JSON.stringify({ choices: [{ delta: { content: 'a'.repeat(13_000) } }] })}\n\n`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(data, { status: 200 })));
    let count = 0;
    for await (const chunk of streamGemini([{ role: 'user', content: 'hi' }], 'user-1', fakeRedis)) count += chunk.length;
    expect(count).toBe(12_000);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout mock containing mock-server-key'); }));
    await expect(completeWithGemini([{ role: 'user', content: 'private prompt' }], 'user-1', fakeRedis)).rejects.toThrow('временно недоступен');
    await expect(completeWithGemini([{ role: 'user', content: 'private prompt' }], 'user-1', fakeRedis)).rejects.not.toThrow('mock-server-key');
  });
});
