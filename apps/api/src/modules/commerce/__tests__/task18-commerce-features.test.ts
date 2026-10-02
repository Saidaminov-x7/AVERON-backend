import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { describe, expect, it, vi } from 'vitest';
import { outfitsModule } from '../outfits';
import { normalizePromoCode, promoFailureCode } from '../commerce-promos';
import { wishlistModule } from '../wishlist';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000002';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000003';
const JWT_SECRET = 'task18-feature-routes-test-secret-at-least-32-characters';

function makeApp(prisma: Record<string, unknown>, modules: Array<unknown>) {
  const app = Fastify();
  app.register(fastifyJwt, { secret: JWT_SECRET });
  app.decorate('prisma', prisma as never);
  for (const module of modules) app.register(module as never, { prefix: '/api/v1' });
  return app;
}

async function tokenFor(app: ReturnType<typeof Fastify>, userId = USER_ID) {
  await app.ready();
  return app.jwt.sign({ userId, role: 'USER' });
}

describe('Task 18 outfit boundary', () => {
  it('scopes saved-outfit reads to the authenticated owner', async () => {
    const findFirst = vi.fn(async () => null);
    const app = makeApp({ outfit: { findFirst } }, [outfitsModule]);
    const token = await tokenFor(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/outfits/00000000-0000-4000-8000-000000000004',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: '00000000-0000-4000-8000-000000000004', userId: USER_ID },
    }));
    await app.close();
  });

  it('rejects client-provided prices and IDs that do not resolve to published products', async () => {
    const findMany = vi.fn(async () => []);
    const create = vi.fn();
    const app = makeApp({
      commerceProduct: { findMany },
      outfit: { create },
    }, [outfitsModule]);
    const token = await tokenFor(app);
    const fakePrice = await app.inject({
      method: 'POST',
      url: '/api/v1/outfits',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Look', items: [{ productId: PRODUCT_ID, price: 1 }] },
    });
    const fakeProduct = await app.inject({
      method: 'POST',
      url: '/api/v1/outfits',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Look', items: [{ productId: PRODUCT_ID }] },
    });
    expect(fakePrice.statusCode).toBe(400);
    expect(fakeProduct.statusCode).toBe(409);
    expect(fakeProduct.json().code).toBe('PRODUCT_NOT_AVAILABLE');
    expect(create).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('Task 18 wishlist sharing boundary', () => {
  it('returns only canonical public product fields and never owner PII', async () => {
    const owner = {
      id: OTHER_USER_ID,
      productFavorites: [{
        product: {
          id: PRODUCT_ID,
          slug: 'shirt',
          translations: { en: { title: 'Shirt' } },
          salePriceUzs: { toString: () => '120000.00' },
          stock: 0,
          preorderEnabled: true,
          preorderLimit: 2,
          preorderReserved: 1,
          images: [{ url: 'https://cdn.example/shirt.jpg' }],
        },
      }],
      email: 'private@example.test',
      phone: '+998000000000',
      address: 'private',
    };
    const findFirst = vi.fn(async () => owner);
    const app = makeApp({ user: { findFirst } }, [wishlistModule]);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/wishlists/shared/${'a'.repeat(43)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [{
        id: PRODUCT_ID,
        slug: 'shirt',
        title: 'Shirt',
        imageUrl: 'https://cdn.example/shirt.jpg',
        priceUzs: '120000.00',
        available: true,
      }],
    });
    expect(response.body).not.toContain('private@example.test');
    expect(response.body).not.toContain(OTHER_USER_ID);
    await app.close();
  });

  it('returns not found for revoked share tokens', async () => {
    const app = makeApp({ user: { findFirst: vi.fn(async () => null) } }, [wishlistModule]);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/wishlists/shared/${'b'.repeat(43)}`,
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe('Task 18 promo policy', () => {
  it('normalizes codes and rejects inactive, future, expired, and exhausted codes', () => {
    expect(normalizePromoCode('  spring10 ')).toBe('SPRING10');
    const now = new Date('2026-10-02T12:00:00Z');
    const base = { isActive: true, startsAt: null, expiresAt: null, maxActivations: 5, usedActivations: 2 };
    expect(promoFailureCode({ ...base, isActive: false }, now)).toBe('PROMO_NOT_ACTIVE');
    expect(promoFailureCode({ ...base, startsAt: new Date('2026-10-03T12:00:00Z') }, now)).toBe('PROMO_NOT_STARTED');
    expect(promoFailureCode({ ...base, expiresAt: new Date('2026-10-02T11:00:00Z') }, now)).toBe('PROMO_EXPIRED');
    expect(promoFailureCode({ ...base, maxActivations: 2 }, now)).toBe('PROMO_LIMIT_REACHED');
    expect(promoFailureCode(base, now)).toBeNull();
  });
});
