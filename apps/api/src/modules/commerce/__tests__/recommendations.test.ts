import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyJwt from '@fastify/jwt';
import { describe, expect, it, vi } from 'vitest';
import { createRecommendationsModule } from '../recommendations';

const availableProduct = {
  id: 'canonical-product-id',
  slug: 'valid-product',
  status: 'PUBLISHED',
  stock: 2,
  preorderEnabled: false,
  preorderLimit: 0,
  preorderReserved: 0,
  preorderEstimatedAt: null,
  salePriceUzs: '125000',
  compareAtPriceUzs: null,
  translations: { en: { title: 'Canonical title' } },
  images: [],
  variants: [{ id: 'variant-1', active: true, stock: 2 }],
  category: { id: 'category-1', active: true },
  reviews: [],
};

function flags(enabled: boolean) {
  return { isEnabled: () => enabled };
}

async function buildApp(prisma: object, enabled = true) {
  const app = Fastify();
  app.decorate('prisma', prisma as never);
  await app.register(fastifyJwt, {
    secret: globalThis.crypto.randomUUID().replaceAll('-', '').repeat(2),
  });
  await app.register(fastifyCookie);
  await app.register(createRecommendationsModule({ flags: flags(enabled) }), { prefix: '/api/v1' });
  await app.ready();
  return app;
}

describe('recommendation routes', () => {
  it('gates recommendation routes when the centralized feature flag is disabled', async () => {
    const findFirst = vi.fn();
    const app = await buildApp({ commerceProduct: { findFirst } }, false);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/products/valid-product/recommendations',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: 'FEATURE_DISABLED' });
    expect(findFirst).not.toHaveBeenCalled();
    await app.close();
  });

  it('derives recently-viewed ownership from the verified token, not request data', async () => {
    const upsert = vi.fn(async (_input: { create: Record<string, unknown> }) => ({}));
    const prisma = {
      commerceProduct: {
        findFirst: vi.fn(async () => availableProduct),
      },
      commerceRecentlyViewedProduct: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        upsert,
        findMany: vi.fn(async () => []),
      },
    };
    const app = await buildApp(prisma);
    const token = app.jwt.sign({ userId: 'authenticated-user', role: 'USER' });
    const tamperedResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/recommendations/recently-viewed',
      headers: { authorization: `Bearer ${token}` },
      payload: { slug: 'valid-product', userId: 'attacker-selected-user' },
    });
    expect(tamperedResponse.statusCode).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/recommendations/recently-viewed',
      headers: { authorization: `Bearer ${token}` },
      payload: { slug: 'valid-product' },
    });

    expect(response.statusCode).toBe(202);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ userId: 'authenticated-user', productId: 'canonical-product-id' }),
    }));
    expect(JSON.stringify(upsert.mock.calls)).not.toContain('attacker-selected-user');
    const spoofedRead = await app.inject({
      method: 'GET',
      url: '/api/v1/recommendations/recently-viewed?userId=attacker-selected-user',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(spoofedRead.statusCode).toBe(400);
    const ownedRead = await app.inject({
      method: 'GET',
      url: '/api/v1/recommendations/recently-viewed',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ownedRead.statusCode).toBe(200);
    expect(prisma.commerceRecentlyViewedProduct.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: 'authenticated-user' }),
    }));
    await app.close();
  });

  it('isolates anonymous history with a server-issued opaque session cookie', async () => {
    const upsert = vi.fn(async (_input: { create: Record<string, unknown> }) => ({}));
    const prisma = {
      commerceProduct: {
        findFirst: vi.fn(async () => availableProduct),
      },
      commerceRecentlyViewedProduct: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        upsert,
        findMany: vi.fn(async () => []),
      },
    };
    const app = await buildApp(prisma);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/recommendations/recently-viewed',
      payload: { slug: 'valid-product' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers['set-cookie']).toContain('averonRecommendationSession=');
    const create = upsert.mock.calls[0]?.[0].create;
    expect(create).toHaveProperty('sessionKey');
    expect(create).not.toHaveProperty('userId');
    expect(String(create.sessionKey)).not.toMatch(/^[A-Za-z0-9_-]{43}$/);
    await app.close();
  });

  it('uses anonymous browsing history for personalized recommendations', async () => {
    const candidate = {
      ...availableProduct,
      id: 'candidate-product-id',
      slug: 'candidate-product',
      createdAt: new Date('2026-09-02T00:00:00.000Z'),
      publishedAt: new Date('2026-09-02T00:00:00.000Z'),
      category: { ...availableProduct.category, name: { en: 'Clothing' }, parentId: null },
    };
    const findMany = vi.fn(async () => [{
      productId: 'previously-viewed-product',
      product: { categoryId: 'category-1' },
    }]);
    const prisma = {
      commerceProduct: {
        findFirst: vi.fn(async () => availableProduct),
        findMany: vi.fn(async () => [candidate]),
      },
      commerceRecentlyViewedProduct: { findMany },
    };
    const app = await buildApp(prisma);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/products/valid-product/recommendations?strategy=personalized',
      headers: { cookie: `averonRecommendationSession=${'A'.repeat(43)}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().meta).toMatchObject({ strategy: 'PERSONALIZED', personalized: true });
    expect(response.json().items.map((item: { product: { id: string } }) => item.product.id))
      .toEqual(['candidate-product-id']);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sessionKey: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    }));
    await app.close();
  });
});
