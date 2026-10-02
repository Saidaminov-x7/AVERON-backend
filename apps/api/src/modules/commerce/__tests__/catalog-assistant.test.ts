import Fastify from 'fastify';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { CatalogAiError, type CatalogAiService } from '../catalog-ai-service';
import { createCatalogAssistantModule } from '../catalog-assistant';
import type { StyleIntent } from '../catalog-assistant-schemas';

function product(
  id: string,
  slug: string,
  categorySlug: string,
  options: { stock?: number; status?: string; active?: boolean; price?: number; color?: string } = {},
) {
  return {
    id,
    slug,
    status: options.status ?? 'PUBLISHED',
    stock: options.stock ?? 1,
    preorderEnabled: false,
    preorderLimit: 0,
    preorderReserved: 0,
    preorderEstimatedAt: null,
    salePriceUzs: new Prisma.Decimal(options.price ?? 100_000),
    compareAtPriceUzs: null,
    translations: { en: { title: slug } },
    material: null,
    images: [],
    variants: [{ id: `${id}-variant`, active: true, stock: options.stock ?? 1, color: options.color ?? 'black', size: 'M' }],
    category: { id: `${categorySlug}-id`, slug: categorySlug, name: { en: categorySlug }, active: options.active ?? true },
  };
}

function ai(overrides: Partial<CatalogAiService> = {}): CatalogAiService {
  return {
    isConfigured: () => true,
    safeModel: () => 'test-model',
    parseSearchIntent: vi.fn(async () => ({ query: 'shirt', category: 'tops' })),
    parseStyleIntent: vi.fn(async (): Promise<StyleIntent> => ({ requiredCategories: ['top', 'bottom', 'shoes'], budgetUzs: 750_000, preorderAllowed: false })),
    ...overrides,
  };
}

async function testApp({
  enabled = true,
  aiService = ai(),
  products = [],
  baseProduct = null,
}: {
  enabled?: boolean;
  aiService?: CatalogAiService;
  products?: ReturnType<typeof product>[];
  baseProduct?: ReturnType<typeof product> | null;
} = {}) {
  const prisma = {
    commerceProduct: {
      findMany: vi.fn(async () => products),
      findFirst: vi.fn(async () => baseProduct),
    },
  };
  const app = Fastify();
  app.decorate('prisma', prisma as never);
  await app.register(createCatalogAssistantModule({
    ai: aiService,
    isEnabled: () => enabled,
  }), { prefix: '/api/v1' });
  await app.ready();
  return { app, prisma };
}

describe('catalog assistant routes', () => {
  it('returns a controlled disabled response without calling the provider', async () => {
    const aiService = ai();
    const { app, prisma } = await testApp({ enabled: false, aiService });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/products/ai-search',
      payload: { query: 'black hoodie', locale: 'en' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: 'FEATURE_DISABLED' });
    expect(aiService.parseSearchIntent).not.toHaveBeenCalled();
    expect(prisma.commerceProduct.findMany).not.toHaveBeenCalled();
    await app.close();
  });

  it('uses strict server filters and returns only visible, available database products', async () => {
    const visible = product('visible', 'black-shirt', 'tops', { price: 345_000 });
    const outOfStock = product('empty', 'empty-shirt', 'tops', { stock: 0 });
    const draft = product('draft', 'draft-shirt', 'tops', { status: 'DRAFT' });
    const inactiveCategory = product('inactive-category', 'inactive-shirt', 'tops', { active: false });
    const { app, prisma } = await testApp({ products: [visible, outOfStock, draft, inactiveCategory] });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/products/ai-search',
      payload: { query: 'black shirt under 400000', locale: 'en' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: { id: string }) => item.id)).toEqual(['visible']);
    expect(response.json().items[0].salePriceUzs).toBe('345000');
    expect(response.json().meta).toMatchObject({ aiUsed: true, fallbackUsed: false });
    expect(prisma.commerceProduct.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: 'PUBLISHED',
        category: { slug: 'tops', active: true },
      }),
      take: 96,
    }));
    await app.close();
  });

  it('keeps catalog search usable with explicit fallback metadata when no provider is configured', async () => {
    const aiService = ai({
      parseSearchIntent: vi.fn(async () => { throw new CatalogAiError('PROVIDER_NOT_CONFIGURED'); }),
    });
    const { app } = await testApp({ aiService, products: [product('real', 'hoodie', 'tops')] });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/products/ai-search',
      payload: { query: 'oversized black hoodie', locale: 'en' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(response.json().meta).toEqual({
      aiUsed: false,
      fallbackUsed: true,
      fallbackReason: 'PROVIDER_NOT_CONFIGURED',
    });
    await app.close();
  });

  it('matches localized colors in database variants after normalizing search intent', async () => {
    const localizedProduct = product('localized', 'black-shirt', 'tops', { color: 'черная' });
    const { app, prisma } = await testApp({
      aiService: ai({
        parseSearchIntent: vi.fn(async () => ({ query: 'shirt', colors: ['черная'], sizes: ['M'] })),
      }),
      products: [localizedProduct],
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/products/ai-search',
      payload: { query: 'черная рубашка размера M', locale: 'ru' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: { id: string }) => item.id)).toEqual(['localized']);
    expect(prisma.commerceProduct.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        variants: {
          some: expect.objectContaining({
            active: true,
            size: { in: ['M'] },
            OR: expect.arrayContaining([
              { color: { contains: 'черн', mode: 'insensitive' } },
            ]),
          }),
        },
      }),
    }));
    await app.close();
  });

  it('never exceeds the requested outfit budget and reports partial catalog availability', async () => {
    const { app } = await testApp({
      aiService: ai({
        parseStyleIntent: vi.fn(async (): Promise<StyleIntent> => ({
          requiredCategories: ['top', 'bottom', 'shoes'],
          budgetUzs: 750_000,
          preorderAllowed: false,
        })),
      }),
      products: [
        product('top', 'shirt', 'tops', { price: 300_000 }),
        product('bottom', 'trousers', 'bottoms', { price: 300_000 }),
        product('shoes', 'sneakers', 'shoes', { price: 300_000 }),
      ],
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/style-assistant/outfits',
      payload: { prompt: 'casual outfit under 750000', locale: 'en' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().totalPriceUzs).toBe('600000');
    expect(response.json().withinBudget).toBe(true);
    expect(response.json().complete).toBe(false);
    expect(response.json().items).toHaveLength(2);
    await app.close();
  });

  it('recommends complementary categories without returning the base product', async () => {
    const base = product('base', 'trousers', 'bottoms');
    const { app, prisma } = await testApp({
      baseProduct: base,
      products: [
        base,
        product('top', 'shirt', 'tops'),
        product('shoes', 'sneakers', 'shoes'),
        product('similar', 'jeans', 'bottoms'),
      ],
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/products/trousers/complete-the-look',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: { product: { id: string } }) => item.product.id)).toEqual(['top', 'shoes']);
    expect(response.json().items.some((item: { product: { id: string } }) => item.product.id === 'base')).toBe(false);
    expect(prisma.commerceProduct.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'PUBLISHED', category: { active: true }, id: { not: 'base' } }),
    }));
    await app.close();
  });

  it('rejects extra provider-controlled or client-controlled filter fields', async () => {
    const { app } = await testApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/products/ai-search',
      payload: { query: 'shirt', locale: 'en', price: 1 },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
