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
  publicProduct = null,
  manualProduct = null,
}: {
  maxProductPhotos?: number;
  maxProductPhotoSizeMb?: number;
  mediaSize?: number;
  categoryActive?: boolean;
  publicProduct?: Record<string, any> | null;
  manualProduct?: Record<string, any> | null;
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
    commerceProduct: {
      create: vi.fn(async () => createdProduct),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
        manualProduct ? Object.assign(manualProduct, data) : { ...createdProduct, ...data }),
    },
    importedProduct: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => null),
      findUniqueOrThrow: vi.fn(async () => ({ id: 'import-1', status: 'REJECTED' })),
    },
    commerceCategory: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => where.id === categoryId && category.active ? category : null),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  const prisma = {
    commerceProduct: {
      findMany: vi.fn(async () => publicProduct ? [publicProduct] : []),
      findFirst: vi.fn(async () => publicProduct),
      findUnique: vi.fn(async () => manualProduct),
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
      findUnique: vi.fn(async () => null),
      findUniqueOrThrow: vi.fn(async () => ({ id: 'import-1' })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'import-1', ...data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
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
        preorderEnabled: false,
        preorderLimit: 0,
        preorderReserved: 0,
        preorderEstimatedAt: null,
        images: { create: [expect.objectContaining({ mediaId, sortOrder: 0 })] },
      }),
    }));
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    await app.close();
  });

  it('allows authorized product controls to enable and bound preorders', async () => {
    const estimatedAt = '2031-02-03T00:00:00.000Z';
    const { app, tx } = createTestApp();
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
        preorderEnabled: true,
        preorderLimit: 12,
        preorderEstimatedAt: estimatedAt,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(tx.commerceProduct.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        preorderEnabled: true,
        preorderLimit: 12,
        preorderReserved: 0,
        preorderEstimatedAt: new Date(estimatedAt),
      }),
    }));
    await app.close();
  });

  it('rejects a product preorder limit below already reserved quantity', async () => {
    const manualProduct = {
      id: '00000000-0000-4000-8000-000000000004',
      source: 'MANUAL',
      categoryId: null,
      preorderEnabled: true,
      preorderLimit: 5,
      preorderReserved: 3,
      translations: { ru: { title: 'Jacket' } },
      description: null,
      images: [],
      variants: [],
    };
    const { app, tx } = createTestApp({ manualProduct });
    await start(app);
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/products/${manualProduct.id}`,
      payload: { preorderLimit: 2 },
    });

    expect(response.statusCode).toBe(409);
    expect(tx.commerceProduct.update).not.toHaveBeenCalled();
    await app.close();
  });

  it('updates preorder eligibility, cap and estimate through the existing product endpoint', async () => {
    const manualProduct = {
      id: '00000000-0000-4000-8000-000000000004',
      source: 'MANUAL',
      categoryId: null,
      preorderEnabled: false,
      preorderLimit: 0,
      preorderReserved: 0,
      translations: { ru: { title: 'Jacket' } },
      description: null,
      images: [],
      variants: [],
      salePriceUzs: 180000,
    };
    const { app, tx } = createTestApp({ manualProduct });
    await start(app);
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/products/${manualProduct.id}`,
      payload: {
        preorderEnabled: true,
        preorderLimit: 8,
        preorderEstimatedAt: '2031-02-03T00:00:00.000Z',
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(tx.commerceProduct.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        preorderEnabled: true,
        preorderLimit: 8,
        preorderEstimatedAt: new Date('2031-02-03T00:00:00.000Z'),
      }),
    }));
    await app.close();
  });

  it('exposes authoritative public preorder availability without internal limits', async () => {
    const { app } = createTestApp({
      publicProduct: {
        id: 'product-1',
        slug: 'jacket',
        stock: 0,
        preorderEnabled: true,
        preorderLimit: 5,
        preorderReserved: 2,
        preorderEstimatedAt: new Date('2031-02-03T00:00:00.000Z'),
        variants: [],
      },
    });
    await start(app);
    const response = await app.inject({ method: 'GET', url: '/api/v1/products' });

    expect(response.statusCode).toBe(200);
    expect(response.json().items[0].availability).toEqual({
      inStock: false,
      preorderEligible: true,
      preorderAvailable: 3,
      estimatedAvailableAt: '2031-02-03T00:00:00.000Z',
    });
    expect(response.json().items[0]).not.toHaveProperty('preorderLimit');
    expect(response.json().items[0]).not.toHaveProperty('preorderReserved');
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
    expect(prisma.importedProduct.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
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

  it('does not reopen an already reviewed import through the legacy admin import route', async () => {
    const { app, prisma } = createTestApp();
    const reviewedImport = {
      id: 'import-1',
      source: 'TAOBAO',
      sourceProductId: 'source-456',
      status: 'REJECTED',
    };
    vi.mocked(prisma.importedProduct.findUnique).mockResolvedValue(reviewedImport as never);
    await start(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/imports',
      payload: {
        source: 'TAOBAO',
        sourceProductId: 'source-456',
        sourceUrl: 'https://example.test/item/456',
        originalTitle: 'Cotton jacket',
        sourcePriceCny: 25,
        normalizedPayload: { title: 'Cotton jacket' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result: 'ALREADY_EXISTS', item: { status: 'REJECTED' } });
    expect(prisma.importedProduct.updateMany).not.toHaveBeenCalled();
    expect(prisma.importedProduct.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('only updates a pending import and preserves a concurrent review decision', async () => {
    const { app, prisma } = createTestApp();
    vi.mocked(prisma.importedProduct.findUnique)
      .mockResolvedValueOnce({ id: 'import-1', source: 'TAOBAO', sourceProductId: 'source-456', status: 'PENDING_REVIEW' } as never)
      .mockResolvedValueOnce({ id: 'import-1', status: 'APPROVED' } as never);
    vi.mocked(prisma.importedProduct.updateMany).mockResolvedValue({ count: 0 } as never);
    await start(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/imports',
      payload: {
        source: 'TAOBAO',
        sourceProductId: 'source-456',
        sourceUrl: 'https://example.test/item/456',
        originalTitle: 'Cotton jacket',
        sourcePriceCny: 25,
        normalizedPayload: { title: 'Cotton jacket' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result: 'ALREADY_EXISTS', item: { status: 'APPROVED' } });
    expect(prisma.importedProduct.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'PENDING_REVIEW' }),
    }));
    expect(prisma.importedProduct.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('approves an import as a draft by default and records human audit data', async () => {
    const { app, prisma, tx } = createTestApp();
    vi.mocked(prisma.importedProduct.findUnique).mockResolvedValue({
      id: 'import-1',
      source: 'TAOBAO',
      sourceProductId: 'source-456',
      sourceUrl: 'https://example.test/item/456',
      originalTitle: 'Source jacket',
      sourcePriceCny: null,
      categoryId: null,
      normalizedPayload: { country: 'CN' },
      aiPayload: null,
      status: 'PENDING_REVIEW',
    } as never);
    await start(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/imports/import-1/approve',
      payload: { country: 'CN', salePriceUzs: 180000 },
    });

    expect(response.statusCode).toBe(200);
    expect(tx.commerceProduct.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'DRAFT', publishedAt: null, originalPriceCny: null }),
      include: { images: { orderBy: { sortOrder: 'asc' } } },
    }));
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: '00000000-0000-4000-8000-000000000001',
        action: 'PRODUCT_IMPORT_APPROVED',
        resourceId: 'import-1',
        meta: expect.objectContaining({ published: false }),
      }),
    }));
    await app.close();
  });

  it('rejects an import without creating a product and records the reviewer and reason', async () => {
    const { app, prisma, tx } = createTestApp();
    vi.mocked(prisma.importedProduct.findUnique).mockResolvedValue({
      id: 'import-1',
      originalTitle: 'Source jacket',
      status: 'PENDING_REVIEW',
    } as never);
    await start(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/imports/import-1/reject',
      payload: { reason: 'Source details do not match the product.' },
    });

    expect(response.statusCode).toBe(200);
    expect(tx.importedProduct.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'import-1', status: 'PENDING_REVIEW' },
      data: expect.objectContaining({
        status: 'REJECTED',
        reviewedById: '00000000-0000-4000-8000-000000000001',
        rejectionReason: 'Source details do not match the product.',
      }),
    }));
    expect(tx.commerceProduct.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
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

  it('filters and paginates imported products on the server', async () => {
    const { app, prisma } = createTestApp();
    await start(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/imports?status=PENDING_REVIEW&provider=SOURCE_1688&country=CN&q=coat&from=2026-10-01T00:00:00.000Z&to=2026-10-02T00:00:00.000Z&page=2&limit=10',
    });

    expect(response.statusCode).toBe(200);
    expect(prisma.importedProduct.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: 'PENDING_REVIEW',
        source: 'SOURCE_1688',
        normalizedPayload: { path: ['country'], equals: 'CN' },
        OR: [
          { originalTitle: { contains: 'coat', mode: 'insensitive' } },
          { sourceProductId: { contains: 'coat', mode: 'insensitive' } },
        ],
        createdAt: {
          gte: new Date('2026-10-01T00:00:00.000Z'),
          lte: new Date('2026-10-02T00:00:00.000Z'),
        },
      }),
      skip: 10,
      take: 10,
    }));
    expect(prisma.importedProduct.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'PENDING_REVIEW', source: 'SOURCE_1688' }),
    }));
    await app.close();
  });
});
