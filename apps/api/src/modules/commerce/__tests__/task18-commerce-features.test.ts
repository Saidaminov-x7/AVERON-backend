import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { describe, expect, it, vi } from 'vitest';
import { outfitsModule } from '../outfits';
import { commercePromosModule, normalizePromoCode, promoFailureCode } from '../commerce-promos';
import { wishlistModule } from '../wishlist';
import { capabilitiesModule } from '../../features';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000002';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000003';
const JWT_SECRET = globalThis.crypto.randomUUID().replaceAll('-', '').repeat(2);

function makeApp(prisma: Record<string, unknown>, modules: Array<unknown>) {
  const app = Fastify();
  app.register(fastifyJwt, { secret: JWT_SECRET });
  app.decorate('prisma', prisma as never);
  for (const module of modules) app.register(module as never, { prefix: '/api/v1' });
  return app;
}

async function tokenFor(app: ReturnType<typeof Fastify>, userId = USER_ID, role = 'USER') {
  await app.ready();
  return app.jwt.sign({ userId, role });
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

  it('rejects invalid outfit IDs and keeps newly unpublished products out of saved views', async () => {
    const findFirst = vi.fn(async () => null);
    const findMany = vi.fn(async () => []);
    const app = makeApp({ outfit: { findFirst, findMany } }, [outfitsModule]);
    const token = await tokenFor(app);
    const invalidId = await app.inject({
      method: 'GET',
      url: '/api/v1/outfits/not-a-uuid',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(invalidId.statusCode).toBe(400);
    expect(findFirst).not.toHaveBeenCalled();
    await app.inject({
      method: 'GET',
      url: '/api/v1/outfits',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: USER_ID },
      include: expect.objectContaining({
        items: expect.objectContaining({
          where: { product: { is: { status: 'PUBLISHED' } } },
        }),
      }),
    }));
    await app.close();
  });

  it('rejects oversized outfit item lists before looking up products', async () => {
    const findMany = vi.fn(async () => []);
    const app = makeApp({ commerceProduct: { findMany }, outfit: { create: vi.fn() } }, [outfitsModule]);
    const token = await tokenFor(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/outfits',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'Too many',
        items: Array.from({ length: 13 }, (_, index) => ({
          productId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
        })),
      },
    });
    expect(response.statusCode).toBe(400);
    expect(findMany).not.toHaveBeenCalled();
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
    expect(response.headers['cache-control']).toBe('private, no-store');
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

  it('rejects a discount above 15 percent at the admin API boundary', async () => {
    const create = vi.fn();
    const app = makeApp({
      user: { findUnique: vi.fn(async () => ({ role: 'ADMIN', adminRole: 'SUPER_ADMIN', isBlocked: false, isDeleted: false })) },
      commercePromoCode: { create },
    }, [commercePromosModule]);
    const token = await tokenFor(app, USER_ID, 'ADMIN');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/commerce/promo-codes',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: 'TOO-MUCH', discountPercent: 16, maxActivations: 2 },
    });
    expect(response.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
    await app.close();
  });

  it('validates without consuming a promo and applies canonical normalization', async () => {
    const promo = {
      id: 'promo-1',
      code: 'SPRING10',
      normalizedCode: 'SPRING10',
      discountPercent: 10,
      isActive: true,
      startsAt: null,
      expiresAt: null,
      maxActivations: 5,
      usedActivations: 1,
    };
    const create = vi.fn();
    const app = makeApp({
      commercePromoCode: { findUnique: vi.fn(async () => promo) },
      commercePromoCodeUsage: { findUnique: vi.fn(async () => null), create },
    }, [commercePromosModule]);
    const token = await tokenFor(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/promo-codes/validate',
      headers: { authorization: `Bearer ${token}` },
      payload: { code: ' spring10 ' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ valid: true, code: 'SPRING10', discountPercent: 10, consumed: false });
    expect(create).not.toHaveBeenCalled();
    await app.close();
  });

  it('uses an atomic usage-count guard when an admin lowers an activation cap', async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const app = makeApp({
      user: { findUnique: vi.fn(async () => ({ role: 'ADMIN', adminRole: 'SUPER_ADMIN', isBlocked: false, isDeleted: false })) },
      commercePromoCode: {
        findUnique: vi.fn(async () => ({
          id: 'promo-1',
          code: 'SPRING10',
          normalizedCode: 'SPRING10',
          discountPercent: 10,
          maxActivations: 10,
          usedActivations: 0,
          isActive: true,
          startsAt: null,
          expiresAt: null,
        })),
        updateMany,
      },
    }, [commercePromosModule]);
    const token = await tokenFor(app, USER_ID, 'ADMIN');
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/commerce/promo-codes/promo-1',
      headers: { authorization: `Bearer ${token}` },
      payload: { maxActivations: 1 },
    });
    expect(response.statusCode).toBe(409);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'promo-1', usedActivations: { lte: 1 } },
    }));
    await app.close();
  });
});

describe('Task 18 integration diagnostics', () => {
  it('requires admin access and reports parser configuration separately from its feature flag', async () => {
    const app = makeApp({
      user: {
        findUnique: vi.fn(async () => ({
          role: 'ADMIN',
          adminRole: 'SUPER_ADMIN',
          isBlocked: false,
          isDeleted: false,
        })),
      },
    }, [capabilitiesModule]);
    app.decorate('redis', { ping: vi.fn(async () => 'PONG') } as never);
    const adminToken = await tokenFor(app, USER_ID, 'ADMIN');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/integration-diagnostics',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(200);
    const diagnostics = response.json() as Array<{
      name: string;
      configured: boolean;
      verificationStatus: string;
    }>;
    expect(diagnostics.map(({ name }) => name)).toEqual([
      '1688', 'Pinduoduo', 'AI Product Fill', 'iPost', 'n8n', 'Telegram', 'Currency', 'SMS', 'Redis',
    ]);
    expect(diagnostics.find(({ name }) => name === '1688')).toMatchObject({
      configured: false,
      verificationStatus: 'NOT_LIVE_VERIFIED',
    });
    expect(diagnostics.find(({ name }) => name === 'Currency')).toMatchObject({
      configured: false,
      rateProvider: null,
      currentRate: null,
      rateFetchedAt: null,
      providerTimestamp: null,
      stale: null,
      verificationStatus: 'NOT_LIVE_VERIFIED',
    });
    expect(response.body).not.toMatch(/token|secret|password|apiKey|privateUrl/i);
    await app.close();
  });

  it('does not expose integration diagnostics to a non-admin', async () => {
    const app = makeApp({
      user: {
        findUnique: vi.fn(async () => ({
          role: 'USER',
          adminRole: null,
          isBlocked: false,
          isDeleted: false,
        })),
      },
    }, [capabilitiesModule]);
    app.decorate('redis', { ping: vi.fn(async () => 'PONG') } as never);
    const userToken = await tokenFor(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/integration-diagnostics',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
