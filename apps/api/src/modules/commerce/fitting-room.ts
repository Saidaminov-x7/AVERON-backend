import type { FastifyPluginAsync } from 'fastify';
import { FittingGarmentLayer, Product3DAssetStatus, Product3DAssetSource } from '@prisma/client';
import { z } from 'zod';
import { adminMiddleware } from '../../lib/adminMiddleware';
import { readSingleMultipartFile } from '../../lib/singleMultipartFile';
import { featureFlags } from '../features/feature-flags';
import { Cloudinary3dStorage } from './cloudinary-3d-storage';
import { GlbValidationError, MAX_GLB_SIZE_BYTES, validateGlbWithKhronos } from './glb-validation';

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
          OR: [{ id: params.data.identifier }, { slug: params.data.identifier }, { publicId: params.data.identifier }],
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

    app.get('/admin/products/:productId/fitting-room/assets', { preHandler: adminMiddleware }, async (request, reply) => {
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

    app.post('/admin/products/:productId/fitting-room/assets', {
      preHandler: adminMiddleware,
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
        request.log.error({ err: error, productId: product.id }, '[FittingRoom] GLB upload failed');
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
          request.log.warn({ err: storageError, productId: product.id }, '[FittingRoom] Failed to clean up an unreferenced GLB');
        });
        throw error;
      }
    });

    app.patch('/admin/fitting-room/assets/:assetId', { preHandler: adminMiddleware }, async (request, reply) => {
      const params = z.object({ assetId: z.string().uuid() }).safeParse(request.params);
      const input = updateAssetSchema.safeParse(request.body);
      if (!params.success || !input.success) return reply.status(400).send({ code: 'INVALID_FITTING_ROOM_ASSET' });
      const asset = await app.prisma.product3DAsset.findUnique({ where: { id: params.data.assetId }, select: { id: true, productId: true } });
      if (!asset) return reply.status(404).send({ code: 'ASSET_NOT_FOUND' });
      if (input.data.variantId) {
        const variant = await app.prisma.commerceProductVariant.findFirst({ where: { id: input.data.variantId, productId: asset.productId, active: true }, select: { id: true } });
        if (!variant) return reply.status(400).send({ code: 'VARIANT_NOT_AVAILABLE' });
      }
      const updated = await app.prisma.product3DAsset.update({ where: { id: asset.id }, data: input.data });
      await app.prisma.auditLog.create({ data: { userId: request.user.userId, action: 'PRODUCT_3D_ASSET_UPDATED', resource: 'Product3DAsset', resourceId: asset.id } });
      return { id: updated.id, status: updated.status, garmentLayer: updated.garmentLayer, scale: updated.scale };
    });

    app.post('/admin/fitting-room/assets/:assetId/review', { preHandler: adminMiddleware }, async (request, reply) => {
      const params = z.object({ assetId: z.string().uuid() }).safeParse(request.params);
      const input = reviewSchema.safeParse(request.body);
      if (!params.success || !input.success) return reply.status(400).send({ code: 'INVALID_ASSET_REVIEW' });
      const existing = await app.prisma.product3DAsset.findUnique({ where: { id: params.data.assetId }, select: { id: true, status: true, productId: true } });
      if (!existing) return reply.status(404).send({ code: 'ASSET_NOT_FOUND' });
      const status = input.data.action === 'approve' ? Product3DAssetStatus.APPROVED : Product3DAssetStatus.REJECTED;
      const updated = await app.prisma.$transaction(async (tx) => {
        const result = await tx.product3DAsset.update({
          where: { id: existing.id },
          data: {
            status,
            reviewedById: request.user.userId,
            approvedAt: status === Product3DAssetStatus.APPROVED ? new Date() : null,
            rejectionReason: status === Product3DAssetStatus.REJECTED ? input.data.rejectionReason : null,
          },
        });
        await tx.auditLog.create({
          data: {
            userId: request.user.userId,
            action: status === Product3DAssetStatus.APPROVED ? 'PRODUCT_3D_ASSET_APPROVED' : 'PRODUCT_3D_ASSET_REJECTED',
            resource: 'Product3DAsset',
            resourceId: existing.id,
            meta: { productId: existing.productId, previousStatus: existing.status, status, rejectionReason: input.data.rejectionReason ?? null },
          },
        });
        return result;
      });
      return { id: updated.id, status: updated.status, approvedAt: updated.approvedAt, rejectionReason: updated.rejectionReason };
    });

    app.delete('/admin/fitting-room/assets/:assetId', { preHandler: adminMiddleware }, async (request, reply) => {
      const params = z.object({ assetId: z.string().uuid() }).safeParse(request.params);
      if (!params.success) return reply.status(400).send({ code: 'INVALID_ASSET_ID' });
      const asset = await app.prisma.product3DAsset.findUnique({ where: { id: params.data.assetId } });
      if (!asset) return reply.status(404).send({ code: 'ASSET_NOT_FOUND' });
      await app.prisma.$transaction(async (tx) => {
        await tx.product3DAsset.delete({ where: { id: asset.id } });
        await tx.auditLog.create({ data: { userId: request.user.userId, action: 'PRODUCT_3D_ASSET_DELETED', resource: 'Product3DAsset', resourceId: asset.id } });
      });
      try {
        await storageFactory().delete(asset.fileKey);
      } catch (error) {
        request.log.error({ err: error, assetId: asset.id }, '[FittingRoom] Cloudinary cleanup failed after asset deletion');
        return reply.status(202).send({ code: 'ASSET_DELETED_STORAGE_CLEANUP_PENDING' });
      }
      return reply.status(204).send();
    });

    // No generator is shipped in this release. This endpoint refuses jobs rather than creating a false success state.
    app.post('/admin/products/:productId/fitting-room/generation-jobs', { preHandler: adminMiddleware }, async (_request, reply) =>
      reply.status(503).send({ code: featureFlags.isEnabled('LOCAL_3D_GENERATION') ? 'LOCAL_GENERATION_WORKER_UNAVAILABLE' : 'LOCAL_GENERATION_DISABLED' }),
    );
  };
}

export const fittingRoomModule = createFittingRoomModule();
