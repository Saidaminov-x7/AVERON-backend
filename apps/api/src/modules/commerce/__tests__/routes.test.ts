import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/adminMiddleware', () => ({
  adminMiddleware: async (request: object) => {
    Object.assign(request, {
      user: { userId: '00000000-0000-4000-8000-000000000001', role: 'ADMIN', adminRole: 'SUPER_ADMIN' },
    });
  },
}));

import { commerceModule } from '../index';

const mediaId = '00000000-0000-4000-8000-000000000002';
const categoryId = '00000000-0000-4000-8000-000000000003';

function createTestApp({
  maxProductPhotos = 8,
  maxProductPhotoSizeMb = 5,
  mediaSize = 100,
  categoryActive = true,
}: {
  maxProductPhotos?: number;
  maxProductPhotoSizeMb?: number;
  mediaSize?: number;
  categoryActive?: boolean;
} = {}) {
  const category = {
    id: categoryId,
    slug: 'outerwear',
    name: { ru: 'Верхняя одежда', uz: 'Ustki kiyim', en: 'Outerwear' },
    parentId: null as string | null,
    sortOrder: 0,
    active: categoryActive,
  };
  const createdProduct = {
    id: '00000000-0000-4000-8000-000000000004',
    images: [{ id: '00000000-0000-4000-8000-000000000005', mediaId, url: 'https://cdn.example/photo.jpg', sortOrder: 0 }],
    variants: [],
  };
  const tx = {
    commerceProduct: { create: vi.fn(async () => createdProduct) },
    commerceCategory: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => where.id === categoryId && category.active ? category : null),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  const prisma = {
    commerceProduct: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    commerceCategory: {
      findMany: vi.fn(async () => [category]),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => where.id === categoryId && category.active ? category : null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...category, ...data })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(category, data)),
    },
    siteSettings: {
      findUnique: vi.fn(async () => ({ maxProductPhotos, maxProductPhotoSizeMb })),
    },
    importedProduct: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => create),
    },
    media: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, url: 'https://cdn.example/photo.jpg', size: mediaSize }))),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const app = Fastify();
  app.decorate('prisma', prisma as never);
  return { app, prisma, tx, category };
}

async function start(app: ReturnType<typeof Fastify>) {
  await app.register(commerceModule, { prefix: '/api/v1' });
  await app.ready();
}

describe('commerce admin routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a manual UZS-only product with multiple-photo references and no source URL', async () => {
    const { app, prisma, tx } = createTestApp();
    await start(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      payload: {
        title: 'Test jacket',
        titleUz: 'Sinov kurtkasi',
        titleEn: 'Test jacket',
        country: 'CN',
        salePriceUzs: 180000,
        images: [{ mediaId }],
        publish: false,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.commerceProduct.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        sourceUrl: null,
        originalPriceCny: null,
        exchangeRate: null,
        images: { create: [expect.objectContaining({ mediaId, sortOrder: 0 })] },
      }),
    }));
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    await app.close();
  });

  it('enforces configured photo count and file-size limits before creating products', async () => {
    const tooManyPhotos = Array.from({ length: 9 }, (_, index) => ({
      mediaId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
    }));
    const countApp = createTestApp();
    await start(countApp.app);
    const countResponse = await countApp.app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      payload: {
        title: 'Test jacket',
        titleUz: 'Sinov kurtkasi',
        titleEn: 'Test jacket',
        country: 'CN',
        salePriceUzs: 180000,
        images: tooManyPhotos,
        publish: false,
      },
    });
    expect(countResponse.statusCode).toBe(400);
    expect(countApp.tx.commerceProduct.create).not.toHaveBeenCalled();
    await countApp.app.close();

    const sizeApp = createTestApp({ mediaSize: 5 * 1024 * 1024 + 1 });
    await start(sizeApp.app);
    const sizeResponse = await sizeApp.app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      payload: {
        title: 'Test jacket',
        titleUz: 'Sinov kurtkasi',
        titleEn: 'Test jacket',
        country: 'CN',
        salePriceUzs: 180000,
        images: [{ mediaId }],
        publish: false,
      },
    });
    expect(sizeResponse.statusCode).toBe(400);
    expect(sizeApp.tx.commerceProduct.create).not.toHaveBeenCalled();
    await sizeApp.app.close();
  });

  it('rejects inactive categories for newly created products', async () => {
    const { app, tx } = createTestApp({ categoryActive: false });
    await start(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/products',
      payload: {
        title: 'Test jacket',
        titleUz: 'Sinov kurtkasi',
        titleEn: 'Test jacket',
        country: 'CN',
        salePriceUzs: 180000,
        categoryId,
        images: [{ mediaId }],
        publish: false,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(tx.commerceProduct.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects 1688 imports while their feature is disabled', async () => {
    const { app } = createTestApp();
    await start(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/imports',
      payload: {
        source: 'SOURCE_1688',
        sourceProductId: 'source-123',
        sourceUrl: 'https://example.test/item/123',
        originalTitle: 'Cotton jacket',
        sourcePriceCny: 25,
        normalizedPayload: { title: 'Cotton jacket' },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FEATURE_DISABLED' });
    await app.close();
  });

  it('stores imported source metadata and keeps the item pending human review', async () => {
    const { app, prisma } = createTestApp();
    await start(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/imports',
      payload: {
        source: 'TAOBAO',
        sourceProductId: 'source-456',
        sourceUrl: 'https://example.test/item/456',
        sourceMetadata: { seller: 'seller-2' },
        deduplicationKey: 'TAOBAO:source-456',
        originalTitle: 'Cotton jacket',
        sourcePriceCny: 25,
        normalizedPayload: { title: 'Cotton jacket' },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(prisma.importedProduct.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { source_sourceProductId: { source: 'TAOBAO', sourceProductId: 'source-456' } },
      create: expect.objectContaining({
        status: 'PENDING_REVIEW',
        sourceMetadata: {
          seller: 'seller-2',
          sourceProvider: 'TAOBAO',
          deduplicationKey: 'TAOBAO:source-456',
        },
      }),
    }));
    await app.close();
  });

  it('provides safe category CRUD and archives categories instead of deleting records', async () => {
    const { app, prisma, category } = createTestApp();
    await start(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/categories',
      payload: {
        slug: 'outerwear',
        name: { ru: 'Верхняя одежда', uz: 'Ustki kiyim', en: 'Outerwear' },
      },
    });
    expect(created.statusCode).toBe(201);

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/categories/${categoryId}`,
      payload: { name: { ru: 'Одежда' } },
    });
    expect(updated.statusCode).toBe(200);
    expect(category.name).toMatchObject({ ru: 'Одежда', uz: 'Ustki kiyim', en: 'Outerwear' });

    const archived = await app.inject({ method: 'DELETE', url: `/api/v1/admin/categories/${categoryId}` });
    expect(archived.statusCode).toBe(200);
    expect(category.active).toBe(false);
    expect(prisma.commerceCategory.update).toHaveBeenCalledWith({
      where: { id: categoryId },
      data: { active: false },
    });
    await app.close();
  });

  it('filters public categories to active entries and products by category slug server-side', async () => {
    const { app, prisma } = createTestApp();
    await start(app);
    await app.inject({ method: 'GET', url: '/api/v1/categories' });
    expect(prisma.commerceCategory.findMany).toHaveBeenCalledWith({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { slug: 'asc' }],
    });
    await app.inject({ method: 'GET', url: '/api/v1/products?category=outerwear&page=2' });
    expect(prisma.commerceProduct.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: 'PUBLISHED',
        category: { slug: 'outerwear', active: true },
      }),
      skip: 24,
    }));
    await app.close();
  });
});
