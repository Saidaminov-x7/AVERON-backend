import { config } from '../../config';
import { productAiSuggestionSchema, type ProductAiInput, type ProductAiSuggestion } from './product-ai.schemas';

export interface ProductAiProvider {
  isConfigured(): boolean;
  generateProductContent(input: ProductAiInput): Promise<ProductAiSuggestion>;
}

type FetchLike = typeof fetch;

type ProductAiProviderConfig = {
  apiUrl?: string;
  apiKey?: string;
  model: string;
};

export class OpenAiCompatibleProductAiProvider implements ProductAiProvider {
  constructor(
    private readonly providerConfig: ProductAiProviderConfig = {
      apiUrl: config.AI_PRODUCT_API_URL,
      apiKey: config.AI_PRODUCT_API_KEY,
      model: config.AI_PRODUCT_MODEL,
    },
    private readonly fetcher: FetchLike = fetch,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.providerConfig.apiUrl && this.providerConfig.apiKey);
  }

  async generateProductContent(input: ProductAiInput): Promise<ProductAiSuggestion> {
    if (!this.isConfigured()) throw new Error('AI_PROVIDER_NOT_CONFIGURED');

    const response = await this.fetcher(this.providerConfig.apiUrl!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.providerConfig.apiKey}`,
      },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        model: this.providerConfig.model,
        response_format: { type: 'json_object' },
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: [
              'Create draft localized product copy only in strict JSON with keys ru, uz, en.',
              'Each locale has title, description, and characteristics (string-to-string object).',
              'Analyze attached product images for visible appearance, category, and colors; do not claim hidden material or technical facts unless supplied as text.',
              'Use only facts contained in the supplied product data. Never infer or invent specifications.',
              'Leave unavailable title, description, or characteristic values as empty strings.',
              'Do not output prices, country, images, sizes, SKU, inventory, delivery, URLs, status, or publication actions.',
            ].join(' '),
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ...input,
                  images: input.images.map(({ mimeType }) => ({ mimeType, supplied: true })),
                }),
              },
              ...input.images.map(({ mimeType, data }) => ({
                type: 'image_url' as const,
                image_url: { url: `data:${mimeType};base64,${data.toString('base64')}` },
              })),
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`AI_PROVIDER_HTTP_${response.status}`);
    }

    const responseText = await response.text();
    if (responseText.length > 256_000) throw new Error('AI_PROVIDER_INVALID_RESPONSE');
    let body: unknown;
    try {
      body = JSON.parse(responseText);
    } catch {
      throw new Error('AI_PROVIDER_INVALID_RESPONSE');
    }
    const content = body && typeof body === 'object'
      ? (body as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content
      : undefined;
    if (typeof content !== 'string') throw new Error('AI_PROVIDER_INVALID_RESPONSE');

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('AI_PROVIDER_INVALID_RESPONSE');
    }

    const suggestion = productAiSuggestionSchema.parse(parsed);
    const allowedFactKeys = new Set(Object.keys(input.characteristics));
    for (const locale of ['ru', 'uz', 'en'] as const) {
      suggestion[locale].characteristics = Object.fromEntries(
        Object.entries(suggestion[locale].characteristics)
          .filter(([key]) => allowedFactKeys.has(key)),
      );
    }
    return suggestion;
  }
}

export const productAiProvider = new OpenAiCompatibleProductAiProvider();
