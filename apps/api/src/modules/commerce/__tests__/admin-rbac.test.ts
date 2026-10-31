import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commerceModule } from '../index';
import { productAiModule } from '../product-ai';

const apps: ReturnType<typeof Fastify>[] = [];

async function makeApp(adminRole: 'SUPER_ADMIN' | 'ADMIN' | 'MODERATOR' | 'SUPPORT') {
  const app = Fastify();
  apps.push(app);
  await app.register(fastifyJwt, { secret: 'b'.repeat(64) });
  app.decorate('prisma', {
    authSession: { findFirst: vi.fn(async () => ({ id: 'test-session' })) },
    user: {
      findUnique: vi.fn(async () => ({
        id: 'staff-user',
        role: 'ADMIN',
        adminRole,
        isBlocked: false,
        isDeleted: false,
      })),
    },
    commerceProduct: {
      fields: { compareAtPriceUzs: 'mock-field-ref' },
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    commerceCategory: {
      create: vi.fn(async ({ data }: { data: unknown }) => ({ id: 'new-category', ...data as object })),
    },
    importedProduct: {
      findUnique: vi.fn(async () => null),
    },
    commercePromoCode: { findMany: vi.fn(async () => []) },
    commerceProductReview: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
    },
  } as never);
  await app.register(commerceModule, { prefix: '/commerce' });
  await app.register(productAiModule, { prefix: '/commerce' });
  await app.ready();
  const token = app.jwt.sign({ sessionId: 'test-session', userId: 'staff-user', role: 'ADMIN', adminRole: 'SUPER_ADMIN' });
  return { app, token };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('commerce admin role policy', () => {
  it.each(['SUPPORT', 'MODERATOR'] as const)(
    'does not allow %s to create or edit catalog records',
    async (adminRole) => {
      const { app, token } = await makeApp(adminRole);
      const headers = { authorization: `Bearer ${token}` };

      const category = await app.inject({
        method: 'POST',
        url: '/commerce/admin/categories',
        headers,
        payload: {},
      });
      const product = await app.inject({
        method: 'POST',
        url: '/commerce/admin/products',
        headers,
        payload: {},
      });
      const promos = await app.inject({
        method: 'GET',
        url: '/commerce/admin/commerce/promo-codes',
        headers,
      });
      const ai = await app.inject({
        method: 'POST',
        url: '/commerce/admin/products/ai-suggestions',
        headers,
        payload: {},
      });
      const telegram = await app.inject({
        method: 'POST',
        url: '/commerce/admin/products/00000000-0000-4000-8000-000000000003/telegram-publish',
        headers,
        payload: {},
      });
      const ipost = await app.inject({
        method: 'POST',
        url: '/commerce/admin/orders/AV-123/ipost-shipment',
        headers,
        payload: {},
      });

      expect(category.statusCode).toBe(403);
      expect(product.statusCode).toBe(403);
      expect(promos.statusCode).toBe(403);
      expect(ai.statusCode).toBe(403);
      expect(telegram.statusCode).toBe(403);
      expect(ipost.statusCode).toBe(403);
      if (adminRole === 'SUPPORT') {
        const reviews = await app.inject({ method: 'GET', url: '/commerce/admin/reviews', headers });
        expect(reviews.statusCode).toBe(403);
      }
    },
  );

  it('allows support to read catalog data but not approve an imported listing', async () => {
    const { app, token } = await makeApp('SUPPORT');
    const headers = { authorization: `Bearer ${token}` };
    const catalog = await app.inject({ method: 'GET', url: '/commerce/admin/products', headers });
    const approval = await app.inject({
      method: 'POST',
      url: '/commerce/admin/imports/missing/approve',
      headers,
      payload: { country: 'CN', salePriceUzs: 10000 },
    });

    expect(catalog.statusCode).toBe(200);
    expect(approval.statusCode).toBe(403);
  });

  it('allows moderators to read catalog data and review imported listings', async () => {
    const { app, token } = await makeApp('MODERATOR');
    const headers = { authorization: `Bearer ${token}` };
    const catalog = await app.inject({ method: 'GET', url: '/commerce/admin/products', headers });
    const approval = await app.inject({
      method: 'POST',
      url: '/commerce/admin/imports/missing/approve',
      headers,
      payload: { country: 'CN', salePriceUzs: 10000 },
    });
      const reviews = await app.inject({
        method: 'GET',
        url: '/commerce/admin/reviews',
        headers,
      });

    expect(catalog.statusCode).toBe(200);
    expect(approval.statusCode).toBe(404);
      expect(reviews.statusCode).toBe(200);
  });

  it.each(['ADMIN', 'SUPER_ADMIN'] as const)(
    'allows %s to manage catalog records',
    async (adminRole) => {
      const { app, token } = await makeApp(adminRole);
      const response = await app.inject({
        method: 'POST',
        url: '/commerce/admin/categories',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: { ru: 'Категория', uz: 'Turkum', en: 'Category' } },
      });
      expect(response.statusCode).toBe(201);
    },
  );
});
