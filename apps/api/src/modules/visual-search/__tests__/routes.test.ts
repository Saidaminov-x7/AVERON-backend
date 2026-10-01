import Fastify from 'fastify';
import { fastifyMultipart } from '@fastify/multipart';
import fastifyJwt from '@fastify/jwt';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { VisualSearchCandidate } from '../contracts';
import { VisualSearchError } from '../errors';
import {
  createVisualSearchDependencies,
  createVisualSearchModule,
  type VisualSearchFlags,
} from '../index';
import type { VisualSimilarityService } from '../service';

const enabledFlags: VisualSearchFlags = {
  isEnabled: () => true,
};

const publishedProduct: VisualSearchCandidate = {
  productId: 'product-1',
  productImageId: 'image-1',
  provider: 'provider',
  model: 'model',
  dimensions: 3,
  embeddingVersion: 'v1',
  imageFingerprint: 'fingerprint',
  embedding: [1, 0, 0],
  similarity: 0.9,
  status: 'PUBLISHED',
  product: {
    id: 'product-1',
    slug: 'published-product',
    country: 'CN',
    categoryId: 'category-1',
    translations: { en: { title: 'Published' } },
    salePriceUzs: 100,
    compareAtPriceUzs: null,
    images: [{ id: 'image-1', url: 'https://images.example/item.jpg' }],
  },
};

const draftProduct = {
  ...publishedProduct,
  productId: 'draft-1',
  status: 'DRAFT',
  product: { ...publishedProduct.product, id: 'draft-1', slug: 'draft-product' },
};

interface TestUser {
  id: string;
  role: string;
  adminRole: 'SUPER_ADMIN' | 'ADMIN' | 'MODERATOR' | null;
  isBlocked: boolean;
  isDeleted: boolean;
}

interface TestAuditRecord {
  id: string;
  action: string;
  resourceId: string | null;
  timestamp: Date;
  meta: unknown;
}

async function jpeg() {
  return sharp({
    create: { width: 10, height: 10, channels: 3, background: { r: 40, g: 50, b: 60 } },
  }).jpeg().toBuffer();
}

function multipartBody(buffer: Buffer, mimeType = 'image/jpeg') {
  const boundary = 'visual-search-boundary';
  return {
    boundary,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="upload"\r\nContent-Type: ${mimeType}\r\n\r\n`),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

async function buildApp(
  service: VisualSimilarityService,
  flags: VisualSearchFlags = enabledFlags,
  maxImageBytes = 1024 * 1024,
  auditCreate = vi.fn(async () => ({})),
) {
  const app = Fastify();
  const userFind = vi.fn(async (): Promise<TestUser | null> => null);
  const auditFindMany = vi.fn(async (): Promise<TestAuditRecord[]> => []);
  const auditCount = vi.fn(async (): Promise<number> => 0);
  app.decorate('prisma', {
    auditLog: { create: auditCreate, findMany: auditFindMany, count: auditCount },
    user: { findUnique: userFind },
  } as never);
  await app.register(fastifyJwt, { secret: 'visual-search-test-secret-at-least-32-chars' });
  await app.register(fastifyMultipart);
  const dependencies = createVisualSearchDependencies({
    service,
    flags,
    maxImageBytes,
    rateLimitMax: 5,
    rateLimitWindowSeconds: 60,
    providerTimeoutMs: 500,
  });
  await app.register(createVisualSearchModule(dependencies), { prefix: '/api/v1' });
  return { app, auditCreate, userFind, auditFindMany, auditCount };
}

describe('visual search routes', () => {
  it('returns the backend feature-disabled contract without parsing or processing an upload', async () => {
    const service: VisualSimilarityService = {
      isAvailable: () => false,
      searchImage: vi.fn(),
      findSimilarProducts: vi.fn(),
      reindexProductMainImage: vi.fn(),
      getProductEmbeddingStatus: vi.fn(),
    };
    const { app, auditCreate } = await buildApp(service, { isEnabled: () => false });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/products/visual-search',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: 'FEATURE_DISABLED' });
    expect(service.searchImage).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it('forwards query filters and returns published products without vectors or scores', async () => {
    const service: VisualSimilarityService = {
      isAvailable: () => true,
      searchImage: vi.fn(async () => [publishedProduct, draftProduct]),
      findSimilarProducts: vi.fn(),
      reindexProductMainImage: vi.fn(),
      getProductEmbeddingStatus: vi.fn(),
    };
    const { app, auditCreate } = await buildApp(service);
    const form = multipartBody(await jpeg());

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/products/visual-search?country=CN&category=outerwear&limit=1',
      headers: { 'content-type': `multipart/form-data; boundary=${form.boundary}` },
      payload: form.body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [publishedProduct.product],
      meta: { limit: 1 },
    });
    expect(response.body).not.toContain('embedding');
    expect(response.body).not.toContain('similarity');
    expect(service.searchImage).toHaveBeenCalledWith(expect.any(Buffer), {
      country: 'CN',
      categorySlug: 'outerwear',
      limit: 1,
    }, 500);
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: 'VISUAL_SEARCH',
        meta: expect.objectContaining({ operation: 'visual_search', status: 'success', resultCount: 1 }),
      }),
    }));
    await app.close();
  });

  it('uses the documented default limit when no filters are supplied', async () => {
    const service: VisualSimilarityService = {
      isAvailable: () => true,
      searchImage: vi.fn(async () => []),
      findSimilarProducts: vi.fn(),
      reindexProductMainImage: vi.fn(),
      getProductEmbeddingStatus: vi.fn(),
    };
    const { app } = await buildApp(service);
    const form = multipartBody(await jpeg());

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/products/visual-search',
      headers: { 'content-type': `multipart/form-data; boundary=${form.boundary}` },
      payload: form.body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], meta: { limit: 20 } });
    expect(service.searchImage).toHaveBeenCalledWith(expect.any(Buffer), {
      country: undefined,
      categorySlug: undefined,
      limit: 20,
    }, 500);
    await app.close();
  });

  it.each(['country=INVALID', 'category=not/a-slug', 'limit=0', 'limit=21'])(
    'rejects invalid filter %s before reading an upload',
    async (filter) => {
      const service: VisualSimilarityService = {
        isAvailable: () => true,
        searchImage: vi.fn(),
        findSimilarProducts: vi.fn(),
        reindexProductMainImage: vi.fn(),
        getProductEmbeddingStatus: vi.fn(),
      };
      const { app } = await buildApp(service);

      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/products/visual-search?${filter}`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: 'INVALID_SEARCH_FILTER' });
      expect(service.searchImage).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it('rejects a declared non-image type before provider use', async () => {
    const service: VisualSimilarityService = {
      isAvailable: () => true,
      searchImage: vi.fn(),
      findSimilarProducts: vi.fn(),
      reindexProductMainImage: vi.fn(),
      getProductEmbeddingStatus: vi.fn(),
    };
    const { app } = await buildApp(service);
    const form = multipartBody(Buffer.from('<svg/>'), 'image/svg+xml');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/products/visual-search',
      headers: { 'content-type': `multipart/form-data; boundary=${form.boundary}` },
      payload: form.body,
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({ code: 'IMAGE_UNSUPPORTED' });
    expect(service.searchImage).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects oversized multipart images', async () => {
    const service: VisualSimilarityService = {
      isAvailable: () => true,
      searchImage: vi.fn(),
      findSimilarProducts: vi.fn(),
      reindexProductMainImage: vi.fn(),
      getProductEmbeddingStatus: vi.fn(),
    };
    const { app } = await buildApp(service, enabledFlags, 16);
    const form = multipartBody(Buffer.alloc(128, 1));

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/products/visual-search',
      headers: { 'content-type': `multipart/form-data; boundary=${form.boundary}` },
      payload: form.body,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ code: 'IMAGE_TOO_LARGE' });
    expect(service.searchImage).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns a controlled empty result if the source product embedding is unavailable', async () => {
    const service: VisualSimilarityService = {
      isAvailable: () => true,
      searchImage: vi.fn(),
      findSimilarProducts: vi.fn(async () => { throw new VisualSearchError('EMBEDDING_NOT_AVAILABLE'); }),
      reindexProductMainImage: vi.fn(),
      getProductEmbeddingStatus: vi.fn(),
    };
    const { app } = await buildApp(service);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/products/source/similar?limit=3',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], code: 'EMBEDDING_NOT_AVAILABLE', meta: { limit: 3 } });
    await app.close();
  });

  it('rejects unexpected multipart fields and multiple uploaded files', async () => {
    const service: VisualSimilarityService = {
      isAvailable: () => true,
      searchImage: vi.fn(),
      findSimilarProducts: vi.fn(),
      reindexProductMainImage: vi.fn(),
      getProductEmbeddingStatus: vi.fn(),
    };
    const { app } = await buildApp(service);
    const image = await jpeg();
    const boundary = 'visual-search-boundary';
    const unexpectedField = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="upload"\r\nContent-Type: image/jpeg\r\n\r\n`),
      image,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="country"\r\n\r\nCN\r\n--${boundary}--\r\n`),
    ]);
    const multipleFiles = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="one"\r\nContent-Type: image/jpeg\r\n\r\n`),
      image,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="two"\r\nContent-Type: image/jpeg\r\n\r\n`),
      image,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    for (const payload of [unexpectedField, multipleFiles]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/products/visual-search',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: 'IMAGE_INVALID' });
    }
    expect(service.searchImage).not.toHaveBeenCalled();
    await app.close();
  });

  it('denies anonymous access to the admin Visual Search audit endpoint', async () => {
    const service: VisualSimilarityService = {
      isAvailable: () => false,
      searchImage: vi.fn(),
      findSimilarProducts: vi.fn(),
      reindexProductMainImage: vi.fn(),
      getProductEmbeddingStatus: vi.fn(),
    };
    const { app } = await buildApp(service);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/visual-search/audit',
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('denies admin roles that are not authorized to read the audit history', async () => {
    const service: VisualSimilarityService = {
      isAvailable: () => false,
      searchImage: vi.fn(),
      findSimilarProducts: vi.fn(),
      reindexProductMainImage: vi.fn(),
      getProductEmbeddingStatus: vi.fn(),
    };
    const { app, userFind } = await buildApp(service);
    userFind.mockResolvedValue({
      id: 'moderator-1',
      role: 'USER',
      adminRole: 'MODERATOR',
      isBlocked: false,
      isDeleted: false,
    });
    await app.ready();
    const token = app.jwt.sign({ userId: 'moderator-1', role: 'USER' });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/visual-search/audit',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('returns safe paginated audit metadata to an authorized admin only', async () => {
    const service: VisualSimilarityService = {
      isAvailable: () => false,
      searchImage: vi.fn(),
      findSimilarProducts: vi.fn(),
      reindexProductMainImage: vi.fn(),
      getProductEmbeddingStatus: vi.fn(),
    };
    const { app, userFind, auditFindMany, auditCount } = await buildApp(service);
    userFind.mockResolvedValue({
      id: 'admin-1',
      role: 'USER',
      adminRole: 'ADMIN',
      isBlocked: false,
      isDeleted: false,
    });
    auditFindMany.mockResolvedValue([{
      id: 'audit-1',
      action: 'VISUAL_SEARCH',
      resourceId: 'product-1',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
      meta: {
        operation: 'visual_search',
        status: 'success',
        resultCount: 2,
        durationMs: 10,
        provider: 'provider',
        model: 'model',
        embedding: [1, 2, 3],
        authorization: 'must-not-escape',
      },
    }]);
    auditCount.mockResolvedValue(1);
    await app.ready();
    const token = app.jwt.sign({ userId: 'admin-1', role: 'USER' });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/visual-search/audit?page=1&limit=25',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [{
        id: 'audit-1',
        operation: 'VISUAL_SEARCH',
        timestamp: '2026-01-01T00:00:00.000Z',
        productId: 'product-1',
        status: 'success',
        resultCount: 2,
        durationMs: 10,
        provider: 'provider',
        model: 'model',
      }],
      page: 1,
      limit: 25,
      total: 1,
    });
    expect(response.body).not.toContain('embedding');
    expect(response.body).not.toContain('must-not-escape');
    await app.close();
  });
});
