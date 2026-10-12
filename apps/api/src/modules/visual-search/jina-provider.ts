import type { ImageEmbeddingDescriptor, ImageEmbeddingProvider } from './contracts';

const baseDescriptor: Omit<ImageEmbeddingDescriptor, 'embeddingVersion'> = {
  provider: 'jina',
  model: 'jina-embeddings-v5-omni-small',
  dimensions: 1024,
};

interface JinaEmbeddingResponse {
  data?: Array<{ embedding?: unknown }>;
}

export class JinaImageEmbeddingProvider implements ImageEmbeddingProvider {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly embeddingVersion = 'v1',
  ) {}

  descriptor(): ImageEmbeddingDescriptor {
    return { ...baseDescriptor, embeddingVersion: this.embeddingVersion };
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey?.trim());
  }

  async generateEmbedding(
    image: Buffer,
    signal: AbortSignal,
    task: 'retrieval.query' | 'retrieval.passage' = 'retrieval.query',
  ): Promise<readonly number[]> {
    if (!this.isConfigured()) throw new Error('IMAGE_EMBEDDING_PROVIDER_NOT_CONFIGURED');
    if (!image.length) throw new Error('IMAGE_EMBEDDING_INPUT_INVALID');

    const response = await this.fetchImpl('https://api.jina.ai/v1/embeddings', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: baseDescriptor.model,
        task,
        dimensions: baseDescriptor.dimensions,
        normalized: true,
        embedding_type: 'float',
        input: [{ image: image.toString('base64') }],
      }),
      signal,
    });

    if (!response.ok) throw new Error('IMAGE_EMBEDDING_PROVIDER_REQUEST_FAILED');
    const payload = await response.json() as JinaEmbeddingResponse;
    const embedding = payload.data?.[0]?.embedding;
    if (
      !Array.isArray(embedding)
      || embedding.length !== baseDescriptor.dimensions
      || embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))
    ) {
      throw new Error('IMAGE_EMBEDDING_PROVIDER_RESPONSE_INVALID');
    }
    return embedding as number[];
  }
}
