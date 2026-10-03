import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { productAiInputSchema, productAiRequestSchema, productAiSuggestionSchema } from '../product-ai.schemas';
import { OpenAiCompatibleProductAiProvider } from '../product-ai-provider';
import { productAiModule } from '../product-ai';

vi.mock('../../../lib/adminMiddleware', () => ({
  adminMiddleware: async (request: object) => {
    Object.assign(request, {
      user: { userId: '00000000-0000-4000-8000-000000000001', role: 'ADMIN', adminRole: 'SUPER_ADMIN' },
    });
  },
}));

const input = {
  sourceTitle: 'Cotton jacket',
  sourceDescription: 'Cotton outerwear',
  country: 'CN' as const,
  characteristics: { material: 'cotton' },
  variants: [{ size: 'M', color: 'blue' }],
};

const suggestion = {
  ru: { title: 'Куртка', description: 'Хлопковая куртка', characteristics: { material: 'хлопок' } },
  uz: { title: 'Kurtka', description: 'Paxta kurtka', characteristics: { material: 'paxta' } },
  en: { title: 'Jacket', description: 'Cotton jacket', characteristics: { material: 'cotton' } },
};

describe('product AI draft contract', () => {
  it('rejects the endpoint when its feature flag is disabled', async () => {
    const app = Fastify();
    await app.register(productAiModule, { prefix: '/api/v1' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/products/ai-suggestions',
      payload: input,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FEATURE_DISABLED' });
    await app.close();
  });

  it('rejects protected factual values in AI input and output', () => {
    expect(productAiRequestSchema.safeParse({
      mediaIds: ['00000000-0000-4000-8000-000000000001'],
      country: 'GB',
    }).success).toBe(true);
    expect(productAiRequestSchema.safeParse({
      mediaIds: [],
      country: 'GB',
    }).success).toBe(false);
    expect(productAiInputSchema.safeParse({ ...input, salePriceUzs: 1000 }).success).toBe(false);
    expect(productAiSuggestionSchema.safeParse({
      ...suggestion,
      status: 'PUBLISHED',
      price: 1000,
    }).success).toBe(false);
  });

  it('sends verified image bytes to the vision provider without requiring a source title', async () => {
    let providerRequest: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      providerRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return {
        ok: true,
        text: async () => JSON.stringify({
          choices: [{ message: { content: JSON.stringify(suggestion) } }],
        }),
      };
    }) as unknown as typeof fetch;
    const provider = new OpenAiCompatibleProductAiProvider(
      { apiUrl: 'https://ai.example/v1/chat/completions', apiKey: 'test-key', model: 'test-model' },
      fetcher,
    );
    const visionInput = productAiInputSchema.parse({
      country: 'CN',
      images: [{ mimeType: 'image/png', data: Buffer.from('verified image bytes') }],
    });

    await provider.generateProductContent(visionInput);
    const messages = providerRequest?.messages as Array<{ content?: unknown }>;
    const userContent = messages[1].content as Array<{ image_url?: { url?: string } }>;
    expect(userContent[1].image_url?.url).toBe(
      `data:image/png;base64,${Buffer.from('verified image bytes').toString('base64')}`,
    );
    expect(visionInput.sourceTitle).toBeUndefined();
  });

  it('validates structured output and drops characteristics not present in source facts', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              ...suggestion,
              ru: {
                ...suggestion.ru,
                characteristics: { material: 'хлопок', inventedFact: 'неизвестно' },
              },
            }),
          },
        }],
      }),
    })) as unknown as typeof fetch;
    const provider = new OpenAiCompatibleProductAiProvider(
      { apiUrl: 'https://ai.example/v1/chat/completions', apiKey: 'test-key', model: 'test-model' },
      fetcher,
    );

    const result = await provider.generateProductContent(productAiInputSchema.parse(input));
    expect(result.ru.characteristics).toEqual({ material: 'хлопок' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(result).not.toHaveProperty('price');
    expect(result).not.toHaveProperty('status');
  });

  it('fails closed when provider output is not valid structured JSON', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: '{"ru":{"status":"PUBLISHED"}}' } }] }),
    })) as unknown as typeof fetch;
    const provider = new OpenAiCompatibleProductAiProvider(
      { apiUrl: 'https://ai.example/v1/chat/completions', apiKey: 'test-key', model: 'test-model' },
      fetcher,
    );

    await expect(provider.generateProductContent(productAiInputSchema.parse(input))).rejects.toThrow();
  });
});
