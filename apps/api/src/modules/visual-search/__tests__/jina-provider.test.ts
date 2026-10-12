import { describe, expect, it, vi } from 'vitest';
import { JinaImageEmbeddingProvider } from '../jina-provider';

const vector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0);

describe('Jina image embedding provider', () => {
  it('sends a base64 JPEG image with the requested retrieval task', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ embedding: vector }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const provider = new JinaImageEmbeddingProvider('test-secret', fetchImpl as typeof fetch);

    const result = await provider.generateEmbedding(Buffer.from('image-bytes'), new AbortController().signal, 'retrieval.passage');

    expect(result).toEqual(vector);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.jina.ai/v1/embeddings');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer test-secret' });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'jina-embeddings-v5-omni-small',
      task: 'retrieval.passage',
      dimensions: 1024,
      normalized: true,
      input: [{ image: Buffer.from('image-bytes').toString('base64') }],
    });
  });

  it('does not send requests without a configured key or for empty input', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const unconfigured = new JinaImageEmbeddingProvider('  ', fetchImpl as typeof fetch);
    expect(unconfigured.isConfigured()).toBe(false);
    await expect(unconfigured.generateEmbedding(Buffer.from('image'), new AbortController().signal))
      .rejects.toThrow('IMAGE_EMBEDDING_PROVIDER_NOT_CONFIGURED');

    const configured = new JinaImageEmbeddingProvider('test-secret', fetchImpl as typeof fetch);
    await expect(configured.generateEmbedding(Buffer.alloc(0), new AbortController().signal))
      .rejects.toThrow('IMAGE_EMBEDDING_INPUT_INVALID');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects provider errors without including response details', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('private provider response', { status: 429 }));
    const provider = new JinaImageEmbeddingProvider('test-secret', fetchImpl as typeof fetch);
    await expect(provider.generateEmbedding(Buffer.from('image'), new AbortController().signal))
      .rejects.toThrow('IMAGE_EMBEDDING_PROVIDER_REQUEST_FAILED');
  });

  it('rejects malformed or non-finite vectors', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ embedding: [Number.NaN] }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const provider = new JinaImageEmbeddingProvider('test-secret', fetchImpl as typeof fetch);
    await expect(provider.generateEmbedding(Buffer.from('image'), new AbortController().signal))
      .rejects.toThrow('IMAGE_EMBEDDING_PROVIDER_RESPONSE_INVALID');
  });
});
