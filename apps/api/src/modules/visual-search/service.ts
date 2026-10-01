import { createHash } from 'node:crypto';
import type {
  EmbeddingFingerprintKey,
  ImageEmbeddingDescriptor,
  ImageEmbeddingProvider,
  ProductImageSource,
  VectorSearchRepository,
  VisualSearchCandidate,
  VisualSearchFilters,
} from './contracts';
import { normalizeUploadedImage } from './image';
import { VisualSearchError } from './errors';

export interface VisualSimilarityService {
  isAvailable(): boolean;
  searchImage(
    normalizedImage: Buffer,
    filters: VisualSearchFilters,
    timeoutMs: number,
  ): Promise<VisualSearchCandidate[]>;
  findSimilarProducts(
    identifier: string,
    filters: VisualSearchFilters,
    timeoutMs: number,
  ): Promise<VisualSearchCandidate[]>;
  reindexProductMainImage(productId: string, timeoutMs: number): Promise<void>;
  getProductEmbeddingStatus(productId: string): Promise<{
    status: 'PENDING' | 'INDEXED' | 'FAILED' | 'UNAVAILABLE';
    provider?: string;
    model?: string;
    embeddingVersion?: string;
    lastIndexedAt?: Date;
  }>;
}

function normalizedEmbedding(
  values: readonly number[],
  descriptor: ImageEmbeddingDescriptor,
): number[] {
  if (values.length !== descriptor.dimensions || values.length === 0) {
    throw new VisualSearchError('EMBEDDING_INVALID');
  }

  const magnitude = Math.sqrt(values.reduce((sum, value) => {
    if (!Number.isFinite(value)) throw new VisualSearchError('EMBEDDING_INVALID');
    return sum + value * value;
  }, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new VisualSearchError('EMBEDDING_INVALID');
  }
  return values.map((value) => value / magnitude);
}

function rankCandidates(
  candidates: VisualSearchCandidate[],
  limit: number,
  preferredCategoryId?: string | null,
): VisualSearchCandidate[] {
  return candidates
    .filter((candidate) => candidate.status === 'PUBLISHED' && Number.isFinite(candidate.similarity))
    .sort((left, right) => {
      const leftCategoryBoost = Number(Boolean(preferredCategoryId && left.product.categoryId === preferredCategoryId));
      const rightCategoryBoost = Number(Boolean(preferredCategoryId && right.product.categoryId === preferredCategoryId));
      return rightCategoryBoost - leftCategoryBoost || right.similarity - left.similarity;
    })
    .slice(0, limit);
}

export function createVisualSimilarityService(
  provider: ImageEmbeddingProvider,
  repository: VectorSearchRepository,
  productImageSource: ProductImageSource,
): VisualSimilarityService {
  const descriptor = () => {
    const value = provider.descriptor();
    if (!provider.isConfigured() || !value) {
      throw new VisualSearchError('IMAGE_EMBEDDING_PROVIDER_NOT_CONFIGURED');
    }
    if (!repository.isAvailable()) {
      throw new VisualSearchError('VECTOR_SEARCH_STORAGE_NOT_CONFIGURED');
    }
    return value;
  };

  const generateEmbedding = async (image: Buffer, timeoutMs: number) => {
    const imageDescriptor = descriptor();
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new VisualSearchError('VISUAL_SEARCH_UNAVAILABLE'));
        }, timeoutMs);
      });
      const embedding = await Promise.race([
        provider.generateEmbedding(image, controller.signal),
        timedOut,
      ]);
      return {
        descriptor: imageDescriptor,
        embedding: normalizedEmbedding(embedding, imageDescriptor),
      };
    } catch (error) {
      if (error instanceof VisualSearchError) throw error;
      throw new VisualSearchError('VISUAL_SEARCH_UNAVAILABLE');
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const search = async (
    embedding: readonly number[],
    imageDescriptor: ImageEmbeddingDescriptor,
    filters: VisualSearchFilters,
    preferredCategoryId?: string | null,
    excludeProductId?: string,
  ) => {
    const candidates = await repository.searchCandidates(embedding, imageDescriptor, {
      ...filters,
      preferredCategoryId: preferredCategoryId ?? undefined,
      excludeProductId,
    });
    return rankCandidates(candidates, filters.limit, preferredCategoryId);
  };

  return {
    isAvailable: () => provider.isConfigured() && provider.descriptor() !== null && repository.isAvailable(),

    async searchImage(normalizedImage, filters, timeoutMs) {
      const { descriptor: imageDescriptor, embedding } = await generateEmbedding(normalizedImage, timeoutMs);
      return search(embedding, imageDescriptor, filters);
    },

    async findSimilarProducts(identifier, filters, timeoutMs) {
      const imageDescriptor = descriptor();
      const seed = await repository.getPublishedProductSeed(identifier, imageDescriptor);
      if (!seed || !seed.embedding) throw new VisualSearchError('EMBEDDING_NOT_AVAILABLE');
      return search(
        seed.embedding.embedding,
        imageDescriptor,
        filters,
        seed.categoryId,
        seed.id,
      );
    },

    async reindexProductMainImage(productId, timeoutMs) {
      const imageDescriptor = descriptor();
      const image = await productImageSource.getMainProductImage(productId);
      if (!image) throw new VisualSearchError('EMBEDDING_NOT_AVAILABLE');

      const normalizedImage = await normalizeUploadedImage(image.data, image.mimeType);
      const imageFingerprint = createHash('sha256').update(normalizedImage.data).digest('hex');
      const key: EmbeddingFingerprintKey = {
        productImageId: image.id,
        imageFingerprint,
        ...imageDescriptor,
      };
      if (await repository.hasIndexedFingerprint(key)) return;

      const { embedding } = await generateEmbedding(normalizedImage.data, timeoutMs);
      await repository.storeEmbedding({ ...key, productId, embedding });
    },

    async getProductEmbeddingStatus(productId) {
      if (!repository.isAvailable()) return { status: 'UNAVAILABLE' };
      const imageDescriptor = provider.descriptor();
      if (!provider.isConfigured() || !imageDescriptor) return { status: 'UNAVAILABLE' };
      const status = await repository.getProductImageEmbeddingStatus(productId);
      if (!status) return { status: 'PENDING', ...imageDescriptor };
      return {
        status: status.status,
        provider: status.provider,
        model: status.model,
        embeddingVersion: status.embeddingVersion,
        ...(status.indexedAt ? { lastIndexedAt: status.indexedAt } : {}),
      };
    },
  };
}
