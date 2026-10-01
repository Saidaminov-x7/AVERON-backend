import { AdminRole } from '@prisma/client';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../../config';
import { requireAdminRole } from '../../lib/adminMiddleware';
import { productCountrySchema } from '../commerce/schemas';
import {
  type ImageEmbeddingProvider,
  type ProductImageSource,
  type VectorSearchRepository,
  type VisualSearchCandidate,
} from './contracts';
import { VisualSearchError } from './errors';
import { normalizeUploadedImage } from './image';
import { createVisualSimilarityService, type VisualSimilarityService } from './service';
import {
  imageEmbeddingProvider,
  productImageSource,
  vectorSearchRepository,
  visualSimilarityService,
} from './runtime';
import { featureFlags } from '../features/feature-flags';

const publicSearchQuerySchema = z.object({
  country: productCountrySchema.optional(),
  category: z.string().trim().min(1).max(160).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(20),
});

const similarQuerySchema = z.object({
  country: productCountrySchema.optional(),
  limit: z.coerce.number().int().min(1).max(20).default(12),
});

const adminParamsSchema = z.object({
  productId: z.string().uuid(),
});

export interface VisualSearchFlags {
  isEnabled(flag: 'VISUAL_SEARCH' | 'SIMILAR_PRODUCTS' | 'IMAGE_EMBEDDINGS'): boolean;
}

export interface VisualSearchDependencies {
  provider: ImageEmbeddingProvider;
  repository: VectorSearchRepository;
  productImageSource: ProductImageSource;
  service: VisualSimilarityService;
  flags: VisualSearchFlags;
  maxImageBytes: number;
  rateLimitMax: number;
  rateLimitWindowSeconds: number;
  providerTimeoutMs: number;
}

export function createVisualSearchDependencies(
  overrides: Partial<VisualSearchDependencies> = {},
): VisualSearchDependencies {
  const provider = overrides.provider ?? imageEmbeddingProvider;
  const repository = overrides.repository ?? vectorSearchRepository;
  const imageSource = overrides.productImageSource ?? productImageSource;
  return {
    provider,
    repository,
    productImageSource: imageSource,
    service: overrides.service ?? (
      overrides.provider || overrides.repository || overrides.productImageSource
        ? createVisualSimilarityService(provider, repository, imageSource)
        : visualSimilarityService
    ),
    flags: overrides.flags ?? featureFlags,
    maxImageBytes: overrides.maxImageBytes ?? config.VISUAL_SEARCH_MAX_IMAGE_MB * 1024 * 1024,
    rateLimitMax: overrides.rateLimitMax ?? config.VISUAL_SEARCH_RATE_LIMIT_MAX,
    rateLimitWindowSeconds: overrides.rateLimitWindowSeconds ?? config.VISUAL_SEARCH_RATE_LIMIT_WINDOW_SEC,
    providerTimeoutMs: overrides.providerTimeoutMs ?? config.VISUAL_SEARCH_PROVIDER_TIMEOUT_MS,
  };
}

function featureDisabled(reply: FastifyReply) {
  return reply.status(403).send({ code: 'FEATURE_DISABLED' });
}

function sendServiceError(reply: FastifyReply, error: unknown) {
  if (error instanceof VisualSearchError) {
    if (error.code === 'IMAGE_INVALID') {
      return reply.status(400).send({ code: error.code });
    }
    if (error.code === 'IMAGE_UNSUPPORTED') {
      return reply.status(415).send({ code: error.code });
    }
    if (error.code === 'EMBEDDING_NOT_AVAILABLE') {
      return reply.status(200).send({ items: [], code: error.code });
    }
    return reply.status(503).send({
      code: error.code === 'IMAGE_EMBEDDING_PROVIDER_NOT_CONFIGURED'
        ? error.code
        : 'VISUAL_SEARCH_UNAVAILABLE',
    });
  }
  return reply.status(503).send({ code: 'VISUAL_SEARCH_UNAVAILABLE' });
}

function publicProduct(candidate: VisualSearchCandidate) {
  return candidate.product;
}

async function readSingleImage(request: FastifyRequest, maxImageBytes: number) {
  let result: { buffer: Buffer; mimeType: string } | undefined;
  try {
    for await (const part of request.parts({
      limits: { fileSize: maxImageBytes, files: 1, fields: 0, parts: 1 },
    })) {
      if (part.type !== 'file' || part.fieldname !== 'image') {
        throw new VisualSearchError('IMAGE_INVALID');
      }
      if (result) throw new VisualSearchError('IMAGE_INVALID');

      const chunks: Buffer[] = [];
      for await (const chunk of part.file) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      if (part.file.truncated) {
        const error = new Error('Uploaded image exceeds configured limit') as Error & { statusCode: number };
        error.statusCode = 413;
        throw error;
      }
      result = { buffer: Buffer.concat(chunks), mimeType: part.mimetype };
    }
  } catch (error) {
    if (error instanceof VisualSearchError) throw error;
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && ['FST_REQ_FILE_TOO_LARGE', 'FST_FILES_LIMIT', 'FST_PARTS_LIMIT'].includes(String(error.code))
    ) {
      const limitError = new Error('Uploaded image exceeds configured limit') as Error & { statusCode: number };
      limitError.statusCode = 413;
      throw limitError;
    }
    throw error;
  }
  if (!result) throw new VisualSearchError('IMAGE_INVALID');
  return result;
}

function hasFlag(dependencies: VisualSearchDependencies, flag: 'VISUAL_SEARCH' | 'SIMILAR_PRODUCTS') {
  return dependencies.flags.isEnabled(flag) && dependencies.flags.isEnabled('IMAGE_EMBEDDINGS');
}

export function createVisualSearchModule(
  dependencies: VisualSearchDependencies = createVisualSearchDependencies(),
): FastifyPluginAsync {
  return async (app) => {
    app.post('/products/visual-search', {
      config: {
        rateLimit: {
          max: dependencies.rateLimitMax,
          timeWindow: `${dependencies.rateLimitWindowSeconds} seconds`,
          skipOnError: false,
        },
      },
    }, async (request, reply) => {
      if (!hasFlag(dependencies, 'VISUAL_SEARCH')) return featureDisabled(reply);

      if (!dependencies.service.isAvailable()) {
        return reply.status(503).send({ code: 'IMAGE_EMBEDDING_PROVIDER_NOT_CONFIGURED' });
      }

      let normalized: Awaited<ReturnType<typeof normalizeUploadedImage>>;
      let query: z.infer<typeof publicSearchQuerySchema>;
      let uploadedBuffer: Buffer | undefined;
      try {
        const uploaded = await readSingleImage(request, dependencies.maxImageBytes);
        uploadedBuffer = uploaded.buffer;
        if (uploaded.buffer.length === 0 || uploaded.buffer.length > dependencies.maxImageBytes) {
          return reply.status(uploaded.buffer.length > dependencies.maxImageBytes ? 413 : 400).send({
            code: uploaded.buffer.length > dependencies.maxImageBytes ? 'IMAGE_TOO_LARGE' : 'IMAGE_INVALID',
          });
        }
        query = publicSearchQuerySchema.parse(request.query);
        normalized = await normalizeUploadedImage(uploaded.buffer, uploaded.mimeType);
      } catch (error) {
        if (error instanceof VisualSearchError) return sendServiceError(reply, error);
        if (error instanceof z.ZodError) return reply.status(400).send({ code: 'INVALID_SEARCH_FILTER' });
        const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
          ? Number(error.statusCode)
          : 500;
        if (statusCode === 413) return reply.status(413).send({ code: 'IMAGE_TOO_LARGE' });
        request.log.warn({ requestId: request.id, operation: 'visual_search', status: 'invalid_upload' });
        return reply.status(400).send({ code: 'IMAGE_INVALID' });
      } finally {
        uploadedBuffer?.fill(0);
      }

      const startedAt = Date.now();
      try {
        const candidates = await dependencies.service.searchImage(
          normalized.data,
          {
            country: query.country,
            categorySlug: query.category,
            limit: query.limit,
          },
          dependencies.providerTimeoutMs,
        );
        const items = candidates.filter((item) => item.status === 'PUBLISHED').map(publicProduct);
        request.log.info({
          requestId: request.id,
          operation: 'visual_search',
          provider: dependencies.provider.descriptor()?.provider ?? 'unconfigured',
          model: dependencies.provider.descriptor()?.model ?? 'unconfigured',
          durationMs: Date.now() - startedAt,
          resultCount: items.length,
          status: 'success',
        });
        return reply.send({ items, meta: { limit: query.limit } });
      } catch (error) {
        request.log.warn({
          requestId: request.id,
          operation: 'visual_search',
          provider: dependencies.provider.descriptor()?.provider ?? 'unconfigured',
          model: dependencies.provider.descriptor()?.model ?? 'unconfigured',
          durationMs: Date.now() - startedAt,
          status: 'failed',
          failureCode: error instanceof VisualSearchError ? error.code : 'VISUAL_SEARCH_UNAVAILABLE',
        });
        return sendServiceError(reply, error);
      } finally {
        normalized.data.fill(0);
      }
    });

    app.get<{ Params: { slug: string } }>('/products/:slug/similar', async (request, reply) => {
      if (!hasFlag(dependencies, 'SIMILAR_PRODUCTS')) return featureDisabled(reply);
      const query = similarQuerySchema.safeParse(request.query);
      if (!query.success) return reply.status(400).send({ code: 'INVALID_SEARCH_FILTER' });

      const startedAt = Date.now();
      try {
        const candidates = await dependencies.service!.findSimilarProducts(
          request.params.slug,
          { country: query.data.country, limit: query.data.limit },
          dependencies.providerTimeoutMs,
        );
        const items = candidates.filter((item) => item.status === 'PUBLISHED').map(publicProduct);
        request.log.info({
          requestId: request.id,
          operation: 'similar_products',
          provider: dependencies.provider.descriptor()?.provider ?? 'unconfigured',
          model: dependencies.provider.descriptor()?.model ?? 'unconfigured',
          durationMs: Date.now() - startedAt,
          resultCount: items.length,
          status: 'success',
        });
        return reply.send({ items, meta: { limit: query.data.limit } });
      } catch (error) {
        if (error instanceof VisualSearchError && error.code === 'EMBEDDING_NOT_AVAILABLE') {
          return reply.send({ items: [], code: 'EMBEDDING_NOT_AVAILABLE', meta: { limit: query.data.limit } });
        }
        request.log.warn({
          requestId: request.id,
          operation: 'similar_products',
          durationMs: Date.now() - startedAt,
          status: 'failed',
          failureCode: error instanceof VisualSearchError ? error.code : 'VISUAL_SEARCH_UNAVAILABLE',
        });
        return sendServiceError(reply, error);
      }
    });

    app.get<{ Params: { productId: string } }>('/admin/products/:productId/image-embedding', {
      preHandler: [requireAdminRole(AdminRole.SUPER_ADMIN, AdminRole.ADMIN)],
    }, async (request, reply) => {
      if (!dependencies.flags.isEnabled('IMAGE_EMBEDDINGS')) return featureDisabled(reply);
      const params = adminParamsSchema.safeParse(request.params);
      if (!params.success) return reply.status(400).send({ code: 'INVALID_PRODUCT_ID' });
      try {
        const status = await dependencies.service.getProductEmbeddingStatus(params.data.productId);
        return reply.send(status);
      } catch (error) {
        request.log.warn({
          requestId: request.id,
          operation: 'image_embedding_status',
          productId: params.data.productId,
          status: 'failed',
          failureCode: error instanceof VisualSearchError ? error.code : 'VISUAL_SEARCH_UNAVAILABLE',
        });
        return reply.status(503).send({ code: 'VISUAL_SEARCH_UNAVAILABLE' });
      }
    });

    app.post<{ Params: { productId: string } }>('/admin/products/:productId/image-embedding/reindex', {
      preHandler: [requireAdminRole(AdminRole.SUPER_ADMIN, AdminRole.ADMIN)],
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '1 minute',
          skipOnError: false,
        },
      },
    }, async (request, reply) => {
      if (!dependencies.flags.isEnabled('IMAGE_EMBEDDINGS')) return featureDisabled(reply);
      const params = adminParamsSchema.safeParse(request.params);
      if (!params.success) return reply.status(400).send({ code: 'INVALID_PRODUCT_ID' });

      const startedAt = Date.now();
      try {
        await dependencies.service.reindexProductMainImage(params.data.productId, dependencies.providerTimeoutMs);
        const status = await dependencies.service.getProductEmbeddingStatus(params.data.productId);
        request.log.info({
          requestId: request.id,
          operation: 'image_embedding_reindex',
          productId: params.data.productId,
          provider: dependencies.provider.descriptor()?.provider ?? 'unconfigured',
          model: dependencies.provider.descriptor()?.model ?? 'unconfigured',
          durationMs: Date.now() - startedAt,
          status: status.status,
        });
        return reply.send(status);
      } catch (error) {
        request.log.warn({
          requestId: request.id,
          operation: 'image_embedding_reindex',
          productId: params.data.productId,
          durationMs: Date.now() - startedAt,
          status: 'failed',
          failureCode: error instanceof VisualSearchError ? error.code : 'VISUAL_SEARCH_UNAVAILABLE',
        });
        if (error instanceof VisualSearchError && error.code === 'EMBEDDING_NOT_AVAILABLE') {
          return reply.status(409).send({ code: 'EMBEDDING_NOT_AVAILABLE' });
        }
        return sendServiceError(reply, error);
      }
    });
  };
}

export const visualSearchModule = createVisualSearchModule();
