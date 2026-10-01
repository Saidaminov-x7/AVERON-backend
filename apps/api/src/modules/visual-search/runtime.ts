import {
  UnavailableProductImageSource,
  UnavailableVectorSearchRepository,
  UnconfiguredImageEmbeddingProvider,
} from './contracts';
import { createVisualSimilarityService } from './service';

export const imageEmbeddingProvider = new UnconfiguredImageEmbeddingProvider();
export const vectorSearchRepository = new UnavailableVectorSearchRepository();
export const productImageSource = new UnavailableProductImageSource();

export const visualSimilarityService = createVisualSimilarityService(
  imageEmbeddingProvider,
  vectorSearchRepository,
  productImageSource,
);
