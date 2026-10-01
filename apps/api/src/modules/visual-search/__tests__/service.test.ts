import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  UnconfiguredImageEmbeddingProvider,
  type ImageEmbeddingDescriptor,
  type ImageEmbeddingProvider,
  type ProductImageSource,
  type StoredProductEmbedding,
  type VectorSearchRepository,
  type VisualSearchCandidate,
} from '../contracts';
import { VisualSearchError } from '../errors';
import { createVisualSimilarityService } from '../service';

const descriptor: ImageEmbeddingDescriptor = {
  provider: 'test-provider',
  model: 'test-model',
  dimensions: 3,
  embeddingVersion: 'v1',
};

function candidate(id: string, categoryId: string | null, status = 'PUBLISHED', similarity = 0.8): VisualSearchCandidate {
  const embedding: StoredProductEmbedding = {
    productId: id,
    productImageId: `${id}-image`,
    provider: descriptor.provider,
    model: descriptor.model,
    dimensions: descriptor.dimensions,
    embeddingVersion: descriptor.embeddingVersion,
    imageFingerprint: `${id}-fingerprint`,
    embedding: [1, 0, 0],
  };
  return {
    ...embedding,
    similarity,
    status,
    product: {
      id,
      slug: id,
      country: 'CN',
      categoryId,
      translations: { ru: { title: id } },
      salePriceUzs: 100,
      compareAtPriceUzs: null,
      images: [{ id: `${id}-image`, url: `https://images.example/${id}.jpg` }],
    },
  };
}

function setup(overrides: Partial<{
  provider: ImageEmbeddingProvider;
  repository: VectorSearchRepository;
  productImageSource: ProductImageSource;
}> = {}) {
  const provider = overrides.provider ?? {
    descriptor: () => descriptor,
    isConfigured: () => true,
    generateEmbedding: vi.fn(async () => [3, 0, 0]),
  };
  const repository: VectorSearchRepository = overrides.repository ?? {
    isAvailable: () => true,
    hasIndexedFingerprint: vi.fn(async () => false),
    storeEmbedding: vi.fn(async () => undefined),
    searchCandidates: vi.fn(async () => [
      candidate('other-category', 'category-2', 'PUBLISHED', 0.99),
      candidate('same-category', 'category-1', 'PUBLISHED', 0.6),
      candidate('draft', 'category-1', 'DRAFT', 1),
    ]),
    getPublishedProductSeed: vi.fn(async () => ({
      id: 'source',
      country: 'CN',
      categoryId: 'category-1',
      embedding: {
        productId: 'source',
        productImageId: 'source-image',
        provider: descriptor.provider,
        model: descriptor.model,
        dimensions: descriptor.dimensions,
        embeddingVersion: descriptor.embeddingVersion,
        imageFingerprint: 'source-fingerprint',
        embedding: [1, 0, 0],
      },
    })),
    getProductImageEmbeddingStatus: vi.fn(async () => null),
  };
  const productImageSource = overrides.productImageSource ?? {
    isAvailable: () => false,
    getMainProductImage: vi.fn(async () => null),
  };
  return {
    provider,
    repository,
    service: createVisualSimilarityService(provider, repository, productImageSource),
  };
}

describe('visual similarity service', () => {
  it('normalizes embeddings and returns only published candidates within the requested limit', async () => {
    const { service, repository } = setup();

    const results = await service.searchImage(Buffer.from('normalized'), { limit: 1 }, 100);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('PUBLISHED');
    expect(repository.searchCandidates).toHaveBeenCalledWith(
      [1, 0, 0],
      descriptor,
      expect.objectContaining({ limit: 1 }),
    );
  });

  it('boosts candidates in the same category without replacing vector similarity with a fake score', async () => {
    const { service } = setup();

    const results = await service.findSimilarProducts('source', { limit: 2 }, 100);

    expect(results.map((item) => item.product.id)).toEqual(['same-category', 'other-category']);
    expect(results[0].similarity).toBe(0.6);
  });

  it('asks the repository to exclude the current product for similar products', async () => {
    const { service, repository } = setup();

    await service.findSimilarProducts('source', { limit: 2 }, 100);

    expect(repository.searchCandidates).toHaveBeenCalledWith(
      [1, 0, 0],
      descriptor,
      expect.objectContaining({ excludeProductId: 'source' }),
    );
  });

  it('deduplicates reindex by normalized image fingerprint and compatible model version', async () => {
    const imageData = await sharp({
      create: { width: 12, height: 12, channels: 3, background: { r: 15, g: 25, b: 35 } },
    }).jpeg().toBuffer();
    const source: ProductImageSource = {
      isAvailable: () => true,
      getMainProductImage: async () => ({
        id: 'image-1',
        mimeType: 'image/jpeg',
        data: imageData,
      }),
    };
    const base = setup({ productImageSource: source });
    const repository: VectorSearchRepository = {
      ...base.repository,
      hasIndexedFingerprint: vi.fn(async () => true),
    };
    const { service, provider } = setup({ productImageSource: source, repository });
    const providerCall = vi.spyOn(provider, 'generateEmbedding');

    await service.reindexProductMainImage('product-1', 100);

    expect(repository.hasIndexedFingerprint).toHaveBeenCalledWith(expect.objectContaining({
      productImageId: 'image-1',
      provider: descriptor.provider,
      model: descriptor.model,
      embeddingVersion: descriptor.embeddingVersion,
      imageFingerprint: expect.any(String),
    }));
    expect(providerCall).not.toHaveBeenCalled();
    expect(repository.storeEmbedding).not.toHaveBeenCalled();
  });

  it('fails with a controlled unavailable error when the provider times out', async () => {
    const provider: ImageEmbeddingProvider = {
      descriptor: () => descriptor,
      isConfigured: () => true,
      generateEmbedding: () => new Promise(() => undefined),
    };
    const { service } = setup({ provider });

    await expect(service.searchImage(Buffer.from('image'), { limit: 10 }, 5))
      .rejects.toMatchObject({ code: 'VISUAL_SEARCH_UNAVAILABLE' });
  });

  it('never fabricates a production embedding when no provider is configured', async () => {
    const service = createVisualSimilarityService(
      new UnconfiguredImageEmbeddingProvider(),
      setup().repository,
      { isAvailable: () => false, getMainProductImage: async () => null },
    );

    await expect(service.searchImage(Buffer.from('image'), { limit: 10 }, 10))
      .rejects.toBeInstanceOf(VisualSearchError);
    await expect(service.searchImage(Buffer.from('image'), { limit: 10 }, 10))
      .rejects.toMatchObject({ code: 'IMAGE_EMBEDDING_PROVIDER_NOT_CONFIGURED' });
  });
});
