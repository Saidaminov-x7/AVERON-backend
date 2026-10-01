import Fastify from 'fastify';
import { fastifyMultipart } from '@fastify/multipart';
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
) {
  const app = Fastify();
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
  return app;
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
    const app = await buildApp(service, { isEnabled: () => false });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/products/visual-search',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: 'FEATURE_DISABLED' });
    expect(service.searchImage).not.toHaveBeenCalled();
    await app.close();
  });

  it('validates an uploaded image and returns published products without vectors or scores', async () => {
    const service: VisualSimilarityService = {
      isAvailable: () => true,
      searchImage: vi.fn(async () => [publishedProduct, draftProduct]),
      findSimilarProducts: vi.fn(),
      reindexProductMainImage: vi.fn(),
      getProductEmbeddingStatus: vi.fn(),
    };
    const app = await buildApp(service);
    const form = multipartBody(await jpeg());

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/products/visual-search?country=CN&limit=1',
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
      categorySlug: undefined,
      limit: 1,
    }, 500);
    await app.close();
  });

  it('rejects a declared non-image type before provider use', async () => {
    const service: VisualSimilarityService = {
      isAvailable: () => true,
      searchImage: vi.fn(),
      findSimilarProducts: vi.fn(),
      reindexProductMainImage: vi.fn(),
      getProductEmbeddingStatus: vi.fn(),
    };
    const app = await buildApp(service);
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
    const app = await buildApp(service, enabledFlags, 16);
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
    const app = await buildApp(service);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/products/source/similar?limit=3',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], code: 'EMBEDDING_NOT_AVAILABLE', meta: { limit: 3 } });
    await app.close();
  });
});
