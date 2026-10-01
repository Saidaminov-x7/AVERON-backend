export interface ImageEmbeddingDescriptor {
  provider: string;
  model: string;
  dimensions: number;
  embeddingVersion: string;
}

export interface ImageEmbeddingProvider {
  descriptor(): ImageEmbeddingDescriptor | null;
  isConfigured(): boolean;
  generateEmbedding(image: Buffer, signal: AbortSignal): Promise<readonly number[]>;
}

export interface VisualSearchFilters {
  country?: string;
  categorySlug?: string;
  limit: number;
}

export interface StoredProductEmbedding {
  productId: string;
  productImageId: string;
  provider: string;
  model: string;
  dimensions: number;
  embeddingVersion: string;
  imageFingerprint: string;
  embedding: readonly number[];
}

export interface VisualSearchCandidate extends StoredProductEmbedding {
  similarity: number;
  product: {
    id: string;
    slug: string;
    country: string;
    categoryId: string | null;
    translations: unknown;
    salePriceUzs: string | number;
    compareAtPriceUzs: string | number | null;
    images: Array<{ id: string; url: string; alt?: unknown }>;
  };
  status: string;
}

export interface SimilarProductSeed {
  id: string;
  country: string;
  categoryId: string | null;
  embedding: StoredProductEmbedding | null;
}

export interface EmbeddingFingerprintKey extends ImageEmbeddingDescriptor {
  productImageId: string;
  imageFingerprint: string;
}

export interface ProductImageForEmbedding {
  id: string;
  mimeType: string;
  data: Buffer;
}

export interface ProductImageSource {
  isAvailable(): boolean;
  getMainProductImage(productId: string): Promise<ProductImageForEmbedding | null>;
}

export interface VectorSearchRepository {
  isAvailable(): boolean;
  hasIndexedFingerprint(key: EmbeddingFingerprintKey): Promise<boolean>;
  storeEmbedding(
    key: EmbeddingFingerprintKey & { productId: string; embedding: readonly number[] },
  ): Promise<void>;
  searchCandidates(
    query: readonly number[],
    descriptor: ImageEmbeddingDescriptor,
    filters: VisualSearchFilters & { excludeProductId?: string; preferredCategoryId?: string },
  ): Promise<VisualSearchCandidate[]>;
  getPublishedProductSeed(
    identifier: string,
    descriptor: ImageEmbeddingDescriptor,
  ): Promise<SimilarProductSeed | null>;

  getProductImageEmbeddingStatus(productId: string): Promise<{
    status: 'PENDING' | 'INDEXED' | 'FAILED';
    provider: string;
    model: string;
    embeddingVersion: string;
    indexedAt: Date | null;
  } | null>;
}

export class UnconfiguredImageEmbeddingProvider implements ImageEmbeddingProvider {
  descriptor(): null {
    return null;
  }

  isConfigured(): boolean {
    return false;
  }

  async generateEmbedding(): Promise<never> {
    throw new Error('IMAGE_EMBEDDING_PROVIDER_NOT_CONFIGURED');
  }
}

export class UnavailableVectorSearchRepository implements VectorSearchRepository {
  isAvailable(): boolean {
    return false;
  }

  private unavailable(): never {
    throw new Error('VECTOR_SEARCH_STORAGE_NOT_CONFIGURED');
  }

  async hasIndexedFingerprint(): Promise<boolean> {
    return this.unavailable();
  }

  async storeEmbedding(): Promise<void> {
    return this.unavailable();
  }

  async searchCandidates(): Promise<VisualSearchCandidate[]> {
    return this.unavailable();
  }

  async getPublishedProductSeed(): Promise<SimilarProductSeed | null> {
    return this.unavailable();
  }

  async getProductImageEmbeddingStatus(): Promise<null> {
    return null;
  }
}

export class UnavailableProductImageSource implements ProductImageSource {
  isAvailable(): boolean {
    return false;
  }

  async getMainProductImage(): Promise<null> {
    return null;
  }
}
