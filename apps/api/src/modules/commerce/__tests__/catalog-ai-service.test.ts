import { describe, expect, it, vi } from 'vitest';
import { CatalogAiError, createCatalogAiService } from '../catalog-ai-service';

function completion(content: string, status = 200) {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
  }), { status });
}

describe('catalog AI provider adapter', () => {
  it('reports missing credentials as a controlled configuration state', async () => {
    const service = createCatalogAiService({
      apiUrl: 'https://ai.example.test/v1/chat/completions',
      model: 'gpt-4o-mini',
      timeoutMs: 1000,
    }, vi.fn());

    expect(service.isConfigured()).toBe(false);
    await expect(service.parseSearchIntent('hoodie', 'en')).rejects.toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
    });
  });

  it('sends only bounded intent input and validates returned structured data', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => completion(JSON.stringify({
      query: 'hoodie',
      colors: ['черная', 'qora', 'Blue'],
      maxPrice: 500_000,
      inStockOnly: true,
    })));
    const service = createCatalogAiService({
      apiUrl: 'https://ai.example.test/v1/chat/completions',
      apiKey: 'server-only-test-key',
      model: 'gpt-4o-mini',
      timeoutMs: 1000,
    }, fetcher);

    await expect(service.parseSearchIntent('hoodie до 500 000', 'ru')).resolves.toMatchObject({
      query: 'hoodie',
      colors: ['black', 'black', 'blue'],
      maxPrice: 500_000,
    });
    const call = fetcher.mock.calls.at(0);
    expect(call).toBeDefined();
    if (!call) throw new Error('Provider fetcher was not called');
    const [url, request] = call;
    expect(request).toBeDefined();
    if (!request) throw new Error('Provider request options were not supplied');
    expect(url).toBe('https://ai.example.test/v1/chat/completions');
    expect(new Headers(request.headers).get('authorization')).toBe('Bearer server-only-test-key');
    const body = JSON.parse(String(request.body)) as {
      messages: Array<{ role: string; content: string }>;
      temperature: number;
      max_tokens: number;
    };
    expect(body.messages[1].content).toBe(JSON.stringify({
      query: 'hoodie до 500 000',
      locale: 'ru',
      output: 'search-intent',
    }));
    expect(body.messages[0].content).toContain('untrusted data');
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(500);
    expect(JSON.stringify(body)).not.toContain('server-only-test-key');
  });

  it('rejects unsupported or extra provider output instead of trusting it', async () => {
    const fetcher = vi.fn(async () => completion(JSON.stringify({
      query: 'hoodie',
      productId: 'provider-invented-id',
    })));
    const service = createCatalogAiService({
      apiUrl: 'https://ai.example.test/v1/chat/completions',
      apiKey: 'server-only-test-key',
      model: 'gpt-4o-mini',
      timeoutMs: 1000,
    }, fetcher);

    await expect(service.parseSearchIntent('hoodie', 'en')).rejects.toBeInstanceOf(Error);
  });

  it('maps provider timeouts and upstream failures to controlled errors', async () => {
    const timeoutFetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }),
    );
    const settings = {
      apiUrl: 'https://ai.example.test/v1/chat/completions',
      apiKey: 'server-only-test-key',
      model: 'gpt-4o-mini',
      timeoutMs: 5,
    };
    const timeoutService = createCatalogAiService(settings, timeoutFetcher);
    await expect(timeoutService.parseStyleIntent('autumn outfit', 'en')).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });

    const unavailableService = createCatalogAiService(settings, vi.fn(async () => completion('', 503)));
    await expect(unavailableService.parseSearchIntent('hoodie', 'en')).rejects.toBeInstanceOf(CatalogAiError);
    await expect(unavailableService.parseSearchIntent('hoodie', 'en')).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });
});
