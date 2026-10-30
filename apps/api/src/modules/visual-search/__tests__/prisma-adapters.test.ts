import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { IStorageAdapter } from '../../media/storage';
import { PrismaProductImageSource, PrismaVectorSearchRepository } from '../prisma-adapters';

const vector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0);
const descriptor = {
  provider: 'jina',
  model: 'jina-embeddings-v5-omni-small',
  dimensions: 1024,
  embeddingVersion: 'v1',
};

describe('Prisma visual-search adapters', () => {
  it('keeps vector search disabled unless explicitly enabled', () => {
    const repository = new PrismaVectorSearchRepository({} as PrismaClient, false);
    expect(repository.isAvailable()).toBe(false);
  });

  it('hydrates bounded vector candidates into public product data', async () => {
    const product = {
      id: 'product-1',
      slug: 'blue-shirt',
      country: 'CHINA',
      categoryId: 'category-1',
      translations: { ru: { name: 'Синяя рубашка' } },
      salePriceUzs: { toString: () => '180000' },
      compareAtPriceUzs: null,
      images: [{ id: 'image-1', url: '/uploads/2026-10/test.webp', alt: null }],
    };
    const queryRaw = vi.fn(async () => [{
      productId: 'product-1',
      productImageId: 'image-1',
      provider: descriptor.provider,
      model: descriptor.model,
      dimensions: descriptor.dimensions,
      embeddingVersion: descriptor.embeddingVersion,
      imageFingerprint: 'fingerprint',
      vector: `[${vector.join(',')}]`,
      similarity: 0.94,
    }]);
    const prisma = {
      $queryRaw: queryRaw as unknown as PrismaClient['$queryRaw'],
      commerceProduct: { findMany: vi.fn(async () => [product]) },
    } as unknown as PrismaClient;
    const repository = new PrismaVectorSearchRepository(prisma, true);

    const candidates = await repository.searchCandidates(vector, descriptor, { limit: 5, country: 'CHINA' });

    expect(queryRaw).toHaveBeenCalledOnce();
    expect(prisma.commerceProduct.findMany).toHaveBeenCalledOnce();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      productId: 'product-1',
      similarity: 0.94,
      status: 'PUBLISHED',
      product: { slug: 'blue-shirt', salePriceUzs: '180000' },
    });
  });

  it('loads only a published product image through the configured storage adapter', async () => {
    const findFirst = vi.fn(async () => ({
      id: 'image-1',
      media: { url: '/uploads/2026-10/test.webp', mimeType: 'image/webp', size: 12 },
    }));
    const read = vi.fn(async () => Buffer.from('image-bytes'));
    const source = new PrismaProductImageSource(
      { commerceProductImage: { findFirst } } as unknown as PrismaClient,
      { read } as unknown as IStorageAdapter,
    );

    await expect(source.getMainProductImage('product-1')).resolves.toEqual({
      id: 'image-1',
      mimeType: 'image/webp',
      data: Buffer.from('image-bytes'),
    });
    expect(findFirst).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith('/uploads/2026-10/test.webp');
  });
});
