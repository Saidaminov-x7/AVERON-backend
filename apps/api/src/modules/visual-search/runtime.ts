import {
  UnavailableProductImageSource,
  UnavailableVectorSearchRepository,
  UnconfiguredImageEmbeddingProvider,
} from './contracts';
import { config } from '../../config';
import { JinaImageEmbeddingProvider } from './jina-provider';
import { createVisualSimilarityService } from './service';

export const imageEmbeddingProvider = config.JINA_API_KEY
  ? new JinaImageEmbeddingProvider(config.JINA_API_KEY, fetch, config.ACTIVE_IMAGE_EMBEDDING_VERSION)
  : new UnconfiguredImageEmbeddingProvider();
export const vectorSearchRepository = new UnavailableVectorSearchRepository();
export const productImageSource = new UnavailableProductImageSource();

export function isVisualSearchAvailable(): boolean {
  return config.VISUAL_SEARCH_VECTOR_ENABLED && imageEmbeddingProvider.isConfigured();
}

export const visualSimilarityService = createVisualSimilarityService(
  imageEmbeddingProvider,
  vectorSearchRepository,
  productImageSource,
);
