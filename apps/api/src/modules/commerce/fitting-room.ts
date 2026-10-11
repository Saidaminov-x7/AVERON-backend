import type { FastifyPluginAsync } from 'fastify';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { AdminRole, FittingGarmentLayer, Product3DAssetStatus, Product3DAssetSource } from '@prisma/client';
import { z } from 'zod';
import { requireAdminRole } from '../../lib/adminMiddleware';
import { readSingleMultipartFile } from '../../lib/singleMultipartFile';
import { featureFlags } from '../features/feature-flags';
import { Cloudinary3dStorage } from './cloudinary-3d-storage';
import { GlbValidationError, MAX_GLB_SIZE_BYTES, validateGlbWithKhronos } from './glb-validation';

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

const productParamsSchema = z.object({ productId: z.string().uuid() });
const identifierParamsSchema = z.object({ identifier: z.string().min(1).max(120) });
const uploadQuerySchema = z.object({
  layer: z.nativeEnum(FittingGarmentLayer),
  variantId: z.string().uuid().optional(),
}).strict();
const reviewSchema = z.object({
  action: z.enum(['approve', 'reject']),
  rejectionReason: z.string().trim().max(500).optional(),
}).strict().refine((value) => value.action !== 'reject' || Boolean(value.rejectionReason), {
  path: ['rejectionReason'],
  message: 'A rejection reason is required.',
});
const updateAssetSchema = z.object({
  garmentLayer: z.nativeEnum(FittingGarmentLayer).optional(),
  variantId: z.string().uuid().nullable().optional(),
  positionX: z.number().finite().min(-2).max(2).optional(),
  positionY: z.number().finite().min(-2).max(2).optional(),
  positionZ: z.number().finite().min(-2).max(2).optional(),
  scale: z.number().finite().min(0.25).max(3).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);
const outfitQuerySchema = z.object({
  locale: z.enum(['ru', 'uz', 'en']).default('ru'),
  q: z.string().trim().max(80).optional(),
  variantId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(48).default(24),
}).strict();
const generationRequestSchema = z.object({
  variantId: z.string().uuid().nullable().optional(),
  sourceImageIds: z.array(z.string().uuid()).min(1).max(12),
  garmentLayer: z.nativeEnum(FittingGarmentLayer),
}).strict().refine((value) => new Set(value.sourceImageIds).size === value.sourceImageIds.length, {
  path: ['sourceImageIds'], message: 'Source image IDs must be unique.',
});

type FittingRoomStorage = Pick<Cloudinary3dStorage, 'upload' | 'signedUrl' | 'delete'>;
type StorageFactory = () => FittingRoomStorage;
const defaultStorageFactory: StorageFactory = () => new Cloudinary3dStorage();

function ensureFeatureEnabled() {
  return featureFlags.isEnabled('FITTING_ROOM');
}

function localizedTitle(value: unknown, locale: 'ru' | 'uz' | 'en', fallback: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const translations = value as Record<string, unknown>;
  for (const candidate of [locale, 'ru', 'uz', 'en']) {
    const translated = translations[candidate];
    if (typeof translated === 'string') return translated;
    if (translated && typeof translated === 'object' && 'title' in translated && typeof translated.title === 'string') return translated.title;
  }
  return fallback;
}

function latestAssetPerLayer<T extends { garmentLayer: string; variantId: string | null }>(assets: T[]): T[] {
  const seen = new Set<string>();
  return assets.filter((asset) => {
    const key = `${asset.garmentLayer}:${asset.variantId ?? 'all'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function createFittingRoomModule(storageFactory: StorageFactory = defaultStorageFactory): FastifyPluginAsync {
  return async (app) => {
    const fittingRoomAdmin = { preHandler: [requireAdminRole(AdminRole.SUPER_ADMIN, AdminRole.ADMIN, AdminRole.MODERATOR)] };
    app.get('/fitting-room/products', async (request, reply) => {
      if (!ensureFeatureEnabled()) return reply.status(404).send({ code: 'FEATURE_DISABLED' });
      const query = outfitQuerySchema.safeParse(request.query);
      if (!query.success) return reply.status(400).send({ code: 'INVALID_FITTING_ROOM_QUERY' });
      const products = await app.prisma.commerceProduct.findMany({
        where: {
          status: 'PUBLISHED',
          fittingRoomAssets: {
            some: {
              status: Product3DAssetStatus.APPROVED,
              ...(query.data.variantId
                ? { OR: [{ variantId: null }, { variantId: query.data.variantId }] }
                : {}),
            },
          },
          ...(query.data.q ? {
            OR: [
              { slug: { contains: query.data.q, mode: 'insensitive' } },
              { translations: { path: ['ru', 'title'], string_contains: query.data.q } },
              { translations: { path: ['uz', 'title'], string_contains: query.data.q } },
              { translations: { path: ['en', 'title'], string_contains: query.data.q } },
            ],
          } : {}),
        },
        include: {
          images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } },
          variants: { where: { active: true }, select: { id: true, color: true, size: true, stock: true, salePriceUzs: true } },
          fittingRoomAssets: {
            where: {
              status: Product3DAssetStatus.APPROVED,
              ...(query.data.variantId
                ? { OR: [{ variantId: null }, { variantId: query.data.variantId }] }
                : {}),
            },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true, variantId: true, fileKey: true, garmentLayer: true,
              mannequinVersion: true, positionX: true, positionY: true, positionZ: true, scale: true,
            },
          },
        },
        orderBy: { publishedAt: 'desc' },
        take: query.data.limit,
      });
      const storage = storageFactory();
      return products.map((product) => ({
        id: product.id,
        slug: product.slug,
        title: localizedTitle(product.translations, query.data.locale, product.slug),
        salePriceUzs: String(product.salePriceUzs),
        imageUrl: product.images[0]?.url ?? null,
        variants: product.variants.map((variant) => ({ ...variant, salePriceUzs: String(variant.salePriceUzs) })),
        assets: latestAssetPerLayer(product.fittingRoomAssets).map(({ fileKey, ...asset }) => ({ ...asset, url: storage.signedUrl(fileKey) })),
      }));
    });

    app.get('/products/:identifier/fitting-room', async (request, reply) => {
      if (!ensureFeatureEnabled()) return reply.status(404).send({ code: 'FEATURE_DISABLED' });
      const params = identifierParamsSchema.safeParse(request.params);
      if (!params.success) return reply.status(400).send({ code: 'INVALID_PRODUCT_ID' });
      const query = z.object({ locale: z.enum(['ru', 'uz', 'en']).default('ru') }).strict().safeParse(request.query);
      if (!query.success) return reply.status(400).send({ code: 'INVALID_FITTING_ROOM_QUERY' });
      const product = await app.prisma.commerceProduct.findFirst({
        where: {
          OR: [
            { id: params.data.identifier },
            { slug: params.data.identifier },
            { publicId: params.data.identifier },
            { legacyPublicId: params.data.identifier },
          ],
          status: 'PUBLISHED',
        },
        include: {
          images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } },
          variants: { where: { active: true }, select: { id: true, color: true, size: true, stock: true, salePriceUzs: true } },
          fittingRoomAssets: {
            where: { status: Product3DAssetStatus.APPROVED },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true, variantId: true, fileKey: true, garmentLayer: true,
              mannequinVersion: true, positionX: true, positionY: true, positionZ: true, scale: true,
            },
          },
        },
      });
      if (!product || !product.fittingRoomAssets.length) return reply.status(404).send({ code: 'FITTING_ROOM_MODEL_UNAVAILABLE' });
      const storage = storageFactory();
      return {
        id: product.id,
        slug: product.slug,
        title: localizedTitle(product.translations, query.data.locale, product.slug),
        salePriceUzs: String(product.salePriceUzs),
        imageUrl: product.images[0]?.url ?? null,
        variants: product.variants.map((variant) => ({ ...variant, salePriceUzs: String(variant.salePriceUzs) })),
        assets: latestAssetPerLayer(product.fittingRoomAssets).map(({ fileKey, ...asset }) => ({ ...asset, url: storage.signedUrl(fileKey) })),
      };
    });

    app.get('/admin/products/:productId/fitting-room/assets', fittingRoomAdmin, async (request, reply) => {
      const params = productParamsSchema.safeParse(request.params);
      if (!params.success) return reply.status(400).send({ code: 'INVALID_PRODUCT_ID' });
      const assets = await app.prisma.product3DAsset.findMany({
        where: { productId: params.data.productId },
        include: { variant: { select: { id: true, color: true, size: true } } },
        orderBy: { createdAt: 'desc' },
      });
      const storage = assets.length ? storageFactory() : null;
      return assets.map(({ fileKey, ...asset }) => ({ ...asset, previewUrl: storage?.signedUrl(fileKey) ?? null }));
    });

    app.get('/admin/fitting-room/generation-capabilities', fittingRoomAdmin, async () => ({
      enabled: featureFlags.isEnabled('LOCAL_3D_GENERATION'),
      localWorkerConfigured: Boolean(process.env.LOCAL_3D_GENERATOR_MODULE?.trim() && isAbsolute(process.env.LOCAL_3D_GENERATOR_MODULE.trim())),
    }));

    app.post('/admin/products/:productId/fitting-room/assets', {
      preHandler: fittingRoomAdmin.preHandler,
      config: { rateLimit: { max: 4, timeWindow: '1 minute' } },
    }, async (request, reply) => {
      const params = productParamsSchema.safeParse(request.params);
      const query = uploadQuerySchema.safeParse(request.query);
      if (!params.success) return reply.status(400).send({ code: 'INVALID_PRODUCT_ID' });
      if (!query.success) return reply.status(400).send({ code: 'INVALID_FITTING_ROOM_ASSET' });
      const product = await app.prisma.commerceProduct.findUnique({ where: { id: params.data.productId }, select: { id: true } });
      if (!product) return reply.status(404).send({ code: 'PRODUCT_NOT_FOUND' });
      if (query.data.variantId) {
        const variant = await app.prisma.commerceProductVariant.findFirst({ where: { id: query.data.variantId, productId: product.id, active: true }, select: { id: true } });
        if (!variant) return reply.status(400).send({ code: 'VARIANT_NOT_AVAILABLE' });
      }

      let file;
      try {
        file = await readSingleMultipartFile(request, 'file', MAX_GLB_SIZE_BYTES);
      } catch (error) {
        const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 400;
        return reply.status(statusCode).send({ code: statusCode === 413 ? 'GLB_SIZE_EXCEEDED' : 'INVALID_UPLOAD' });
      }
      let validation;
      try {
        validation = await validateGlbWithKhronos(file.data);
      } catch (error) {
        if (error instanceof GlbValidationError) return reply.status(400).send({ code: error.code });
        throw error;
      }

      let storage: FittingRoomStorage;
      let fileKey: string;
      try {
        storage = storageFactory();
        fileKey = await storage.upload(file.data, validation.fileHash);
      } catch (error) {
        request.log.error({ errorName: safeErrorName(error), productId: product.id }, '[FittingRoom] GLB upload failed');
        return reply.status(502).send({ code: 'FITTING_ROOM_STORAGE_UNAVAILABLE' });
      }
      try {
        const asset = await app.prisma.$transaction(async (tx) => {
          const createdAsset = await tx.product3DAsset.create({
            data: {
              productId: product.id,
              variantId: query.data.variantId ?? null,
              fileKey,
              fileHash: validation.fileHash,
              fileSize: validation.fileSize,
              source: Product3DAssetSource.MANUAL,
              status: Product3DAssetStatus.NEEDS_REVIEW,
              garmentLayer: query.data.layer,
              mannequinVersion: 'averon-neutral-v1',
            validationSummary: validation.warningCount ? `GLB passed validation with ${validation.warningCount} warning(s).` : 'GLB passed Khronos validation.',
              validationDetails: {
                meshCount: validation.meshCount,
                vertexCount: validation.vertexCount,
                materialCount: validation.materialCount,
                textureCount: validation.textureCount,
              validatorWarningCount: validation.warningCount,
              validatorWarnings: validation.warnings,
              },
            },
          });
          await tx.auditLog.create({
            data: { userId: request.user.userId, action: 'PRODUCT_3D_ASSET_UPLOADED', resource: 'Product3DAsset', resourceId: createdAsset.id },
          });
          return createdAsset;
        });
        return reply.status(201).send({
          id: asset.id,
          status: asset.status,
          garmentLayer: asset.garmentLayer,
          fileSize: asset.fileSize,
          validationSummary: asset.validationSummary,
          previewUrl: storage.signedUrl(fileKey),
        });
      } catch (error) {
        await storage.delete(fileKey).catch((storageError: unknown) => {
          request.log.warn({ errorName: safeErrorName(storageError), productId: product.id }, '[FittingRoom] Failed to clean up an unreferenced GLB');
        });
        throw error;
      }
    });

    app.patch('/admin/fitting-room/assets/:assetId', fittingRoomAdmin, async (request, reply) => {
      const params = z.object({ assetId: z.string().uuid() }).safeParse(request.params);
      const input = updateAssetSchema.safeParse(request.body);
      if (!params.success || !input.success) return reply.status(400).send({ code: 'INVALID_FITTING_ROOM_ASSET' });
      const asset = await app.prisma.product3DAsset.findUnique({ where: { id: params.data.assetId }, select: { id: true, productId: true } });
      if (!asset) return reply.status(404).send({ code: 'ASSET_NOT_FOUND' });
      if (input.data.variantId) {
        const variant = await app.prisma.commerceProductVariant.findFirst({ where: { id: input.data.variantId, productId: asset.productId, active: true }, select: { id: true } });
        if (!variant) return reply.status(400).send({ code: 'VARIANT_NOT_AVAILABLE' });
      }
      const updated = await app.prisma.$transaction(async (tx) => {
        const current = await tx.product3DAsset.findUnique({
          where: { id: asset.id },
          select: { status: true, revision: true },
        });
        if (!current) return null;
        const result = await tx.product3DAsset.updateMany({
          where: { id: asset.id, revision: current.revision },
          data: {
            ...input.data,
            revision: { increment: 1 },
            ...(current.status === Product3DAssetStatus.APPROVED ? {
              status: Product3DAssetStatus.NEEDS_REVIEW,
              reviewedById: null,
              approvedAt: null,
              rejectionReason: null,
            } : {}),
          },
        });
        if (result.count !== 1) return null;
        const updatedAsset = await tx.product3DAsset.findUnique({
          where: { id: asset.id },
          select: { id: true, status: true, garmentLayer: true, scale: true },
        });
        if (!updatedAsset) return null;
        await tx.auditLog.create({
          data: {
            userId: request.user.userId,
            action: 'PRODUCT_3D_ASSET_UPDATED',
            resource: 'Product3DAsset',
            resourceId: asset.id,
            meta: { previousStatus: current.status, status: updatedAsset.status, revision: current.revision + 1, changes: input.data },
          },
        });
        return updatedAsset;
      });
      if (!updated) return reply.status(409).send({ code: 'ASSET_CHANGED_RETRY' });
      return { id: updated.id, status: updated.status, garmentLayer: updated.garmentLayer, scale: updated.scale };
    });

    app.post('/admin/fitting-room/assets/:assetId/review', fittingRoomAdmin, async (request, reply) => {
      const params = z.object({ assetId: z.string().uuid() }).safeParse(request.params);
      const input = reviewSchema.safeParse(request.body);
      if (!params.success || !input.success) return reply.status(400).send({ code: 'INVALID_ASSET_REVIEW' });
      const existing = await app.prisma.product3DAsset.findUnique({ where: { id: params.data.assetId }, select: { id: true, status: true, productId: true, revision: true } });
      if (!existing) return reply.status(404).send({ code: 'ASSET_NOT_FOUND' });
      if (existing.status !== Product3DAssetStatus.NEEDS_REVIEW) {
        return reply.status(409).send({ code: 'ASSET_CHANGED_RETRY' });
      }
      const status = input.data.action === 'approve' ? Product3DAssetStatus.APPROVED : Product3DAssetStatus.REJECTED;
      const updated = await app.prisma.$transaction(async (tx) => {
        const result = await tx.product3DAsset.updateMany({
          where: { id: existing.id, status: existing.status, revision: existing.revision },
          data: {
            status,
            reviewedById: request.user.userId,
            approvedAt: status === Product3DAssetStatus.APPROVED ? new Date() : null,
            rejectionReason: status === Product3DAssetStatus.REJECTED ? input.data.rejectionReason : null,
            revision: { increment: 1 },
          },
        });
        if (result.count !== 1) return null;
        const updatedAsset = await tx.product3DAsset.findUnique({
          where: { id: existing.id },
          select: { id: true, status: true, approvedAt: true, rejectionReason: true },
        });
        if (!updatedAsset) return null;
        await tx.auditLog.create({
          data: {
            userId: request.user.userId,
            action: status === Product3DAssetStatus.APPROVED ? 'PRODUCT_3D_ASSET_APPROVED' : 'PRODUCT_3D_ASSET_REJECTED',
            resource: 'Product3DAsset',
            resourceId: existing.id,
            meta: {
              productId: existing.productId,
              previousStatus: existing.status,
              status,
              revision: existing.revision + 1,
              rejectionReason: input.data.rejectionReason ?? null,
            },
          },
        });
        return updatedAsset;
      });
      if (!updated) return reply.status(409).send({ code: 'ASSET_CHANGED_RETRY' });
      return { id: updated.id, status: updated.status, approvedAt: updated.approvedAt, rejectionReason: updated.rejectionReason };
    });

    app.delete('/admin/fitting-room/assets/:assetId', fittingRoomAdmin, async (request, reply) => {
      const params = z.object({ assetId: z.string().uuid() }).safeParse(request.params);
      if (!params.success) return reply.status(400).send({ code: 'INVALID_ASSET_ID' });
      const asset = await app.prisma.product3DAsset.findUnique({ where: { id: params.data.assetId }, select: { id: true, fileKey: true, revision: true } });
      if (!asset) return reply.status(404).send({ code: 'ASSET_NOT_FOUND' });
      const deleted = await app.prisma.$transaction(async (tx) => {
        const result = await tx.product3DAsset.deleteMany({ where: { id: asset.id, revision: asset.revision } });
        if (result.count !== 1) return false;
        await tx.auditLog.create({ data: { userId: request.user.userId, action: 'PRODUCT_3D_ASSET_DELETED', resource: 'Product3DAsset', resourceId: asset.id } });
        return true;
      });
      if (!deleted) return reply.status(409).send({ code: 'ASSET_CHANGED_RETRY' });
      try {
        await storageFactory().delete(asset.fileKey);
      } catch (error) {
        request.log.error({ errorName: safeErrorName(error), assetId: asset.id }, '[FittingRoom] Cloudinary cleanup failed after asset deletion');
        return reply.status(202).send({ code: 'ASSET_DELETED_STORAGE_CLEANUP_PENDING' });
      }
      return reply.status(204).send();
    });

    app.post('/admin/products/:productId/fitting-room/generation-jobs', {
      preHandler: fittingRoomAdmin.preHandler,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    }, async (request, reply) => {
      const params = productParamsSchema.safeParse(request.params);
      const input = generationRequestSchema.safeParse(request.body);
      const idempotencyKey = request.headers['idempotency-key'];
      if (!params.success) return reply.status(400).send({ code: 'INVALID_PRODUCT_ID' });
      if (!input.success) return reply.status(400).send({ code: 'INVALID_GENERATION_REQUEST', issues: input.error.issues });
      if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
        return reply.status(400).send({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
      }
      if (!featureFlags.isEnabled('LOCAL_3D_GENERATION')) return reply.status(503).send({ code: 'LOCAL_GENERATION_DISABLED' });
      if (!process.env.LOCAL_3D_GENERATOR_MODULE?.trim() || !isAbsolute(process.env.LOCAL_3D_GENERATOR_MODULE.trim())) {
        return reply.status(503).send({ code: 'LOCAL_GENERATION_WORKER_UNAVAILABLE' });
      }

      const product = await app.prisma.commerceProduct.findUnique({ where: { id: params.data.productId }, select: { id: true } });
      if (!product) return reply.status(404).send({ code: 'PRODUCT_NOT_FOUND' });
      if (input.data.variantId) {
        const variant = await app.prisma.commerceProductVariant.findFirst({ where: { id: input.data.variantId, productId: product.id, active: true }, select: { id: true } });
        if (!variant) return reply.status(400).send({ code: 'VARIANT_NOT_AVAILABLE' });
      }
      const sourceImages = await app.prisma.commerceProductImage.findMany({
        where: { id: { in: input.data.sourceImageIds }, productId: product.id },
        select: { id: true },
      });
      if (sourceImages.length !== input.data.sourceImageIds.length) return reply.status(400).send({ code: 'SOURCE_IMAGES_NOT_AVAILABLE' });

      const sourceImageIds = [...input.data.sourceImageIds].sort();
      const requestHash = createHash('sha256').update(JSON.stringify({
        variantId: input.data.variantId ?? null,
        sourceImageIds,
        garmentLayer: input.data.garmentLayer,
      })).digest('hex');
      const where = { initiatedById_idempotencyKey: { initiatedById: request.user.userId, idempotencyKey } };
      const existing = await app.prisma.product3DGenerationJob.findUnique({ where });
      if (existing) {
        if (existing.requestHash !== requestHash) return reply.status(409).send({ code: 'IDEMPOTENCY_KEY_REUSED' });
        return reply.send(existing);
      }

      try {
        const job = await app.prisma.$transaction(async (tx) => {
          const created = await tx.product3DGenerationJob.create({ data: {
            productId: product.id,
            variantId: input.data.variantId ?? null,
            initiatedById: request.user.userId,
            idempotencyKey,
            requestHash,
            sourceImageIds,
            garmentLayer: input.data.garmentLayer,
            status: 'QUEUED',
            stage: 'QUEUED',
            maxAttempts: 3,
          } });
          await tx.auditLog.create({ data: {
            userId: request.user.userId,
            action: 'PRODUCT_3D_GENERATION_QUEUED',
            resource: 'Product3DGenerationJob',
            resourceId: created.id,
            meta: { productId: product.id, sourceImageIds, garmentLayer: input.data.garmentLayer },
          } });
          return created;
        });
        return reply.status(202).send(job);
      } catch (error) {
        // A concurrent replay may win the unique key between the read and create.
        const raced = await app.prisma.product3DGenerationJob.findUnique({ where });
        if (!raced) throw error;
        if (raced.requestHash !== requestHash) return reply.status(409).send({ code: 'IDEMPOTENCY_KEY_REUSED' });
        return reply.send(raced);
      }
    });

    app.get('/admin/products/:productId/fitting-room/generation-jobs', fittingRoomAdmin, async (request, reply) => {
      const params = productParamsSchema.safeParse(request.params);
      if (!params.success) return reply.status(400).send({ code: 'INVALID_PRODUCT_ID' });
      const jobs = await app.prisma.product3DGenerationJob.findMany({
        where: { productId: params.data.productId },
        orderBy: { createdAt: 'desc' },
        take: 30,
      });
      return jobs;
    });

    app.post('/admin/fitting-room/generation-jobs/:jobId/cancel', fittingRoomAdmin, async (request, reply) => {
      const params = z.object({ jobId: z.string().uuid() }).safeParse(request.params);
      if (!params.success) return reply.status(400).send({ code: 'INVALID_GENERATION_JOB_ID' });
      const now = new Date();
      const action = await app.prisma.$transaction(async (tx) => {
        const cancelled = await tx.product3DGenerationJob.updateMany({
          where: { id: params.data.jobId, status: 'QUEUED' },
          data: { status: 'CANCELLED', stage: 'CANCELLED', completedAt: now },
        });
        if (cancelled.count === 1) {
          await tx.auditLog.create({ data: { userId: request.user.userId, action: 'PRODUCT_3D_GENERATION_CANCELLED', resource: 'Product3DGenerationJob', resourceId: params.data.jobId } });
          return 'CANCELLED';
        }
        const running = await tx.product3DGenerationJob.updateMany({
          where: { id: params.data.jobId, status: { in: ['RUNNING', 'POSTPROCESSING'] }, cancelRequestedAt: null },
          data: { cancelRequestedAt: now },
        });
        if (running.count !== 1) return null;
        await tx.auditLog.create({ data: { userId: request.user.userId, action: 'PRODUCT_3D_GENERATION_CANCELLATION_REQUESTED', resource: 'Product3DGenerationJob', resourceId: params.data.jobId } });
        return 'CANCELLATION_REQUESTED';
      });
      if (action) return { id: params.data.jobId, status: action };
      const existing = await app.prisma.product3DGenerationJob.findUnique({ where: { id: params.data.jobId } });
      if (!existing) return reply.status(404).send({ code: 'GENERATION_JOB_NOT_FOUND' });
      return reply.status(409).send({ code: 'GENERATION_JOB_NOT_CANCELLABLE', status: existing.status });
    });

    app.post('/admin/fitting-room/generation-jobs/:jobId/retry', fittingRoomAdmin, async (request, reply) => {
      const params = z.object({ jobId: z.string().uuid() }).safeParse(request.params);
      if (!params.success) return reply.status(400).send({ code: 'INVALID_GENERATION_JOB_ID' });
      const retryCount = await app.prisma.$transaction(async (tx) => {
        const retried = await tx.product3DGenerationJob.updateMany({
          where: { id: params.data.jobId, status: 'FAILED', attemptCount: { lt: 3 } },
          data: {
            status: 'QUEUED', stage: 'QUEUED', errorCode: null, errorMessage: null,
            nextAttemptAt: new Date(), startedAt: null, completedAt: null,
            workerId: null, leaseToken: null, leaseExpiresAt: null, cancelRequestedAt: null,
          },
        });
        if (retried.count !== 1) return 0;
        await tx.auditLog.create({ data: { userId: request.user.userId, action: 'PRODUCT_3D_GENERATION_RETRIED', resource: 'Product3DGenerationJob', resourceId: params.data.jobId } });
        return retried.count;
      });
      if (retryCount === 1) return app.prisma.product3DGenerationJob.findUnique({ where: { id: params.data.jobId } });
      const existing = await app.prisma.product3DGenerationJob.findUnique({ where: { id: params.data.jobId } });
      if (!existing) return reply.status(404).send({ code: 'GENERATION_JOB_NOT_FOUND' });
      return reply.status(409).send({ code: existing.attemptCount >= 3 ? 'GENERATION_RETRY_LIMIT_REACHED' : 'GENERATION_JOB_NOT_RETRYABLE', status: existing.status });
    });
  };
}

export const fittingRoomModule = createFittingRoomModule();
