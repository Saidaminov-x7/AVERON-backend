import { CommerceProductReviewStatus, Prisma } from '@prisma/client';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { adminMiddleware } from '../../lib/adminMiddleware';
import { authMiddleware } from '../../lib/authMiddleware';

const uuid = z.string().uuid();
const cleanText = (maximum: number, minimum = 0) => z.string().trim().min(minimum).max(maximum)
  .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), 'Control characters are not allowed');
const reviewContentSchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: cleanText(120).nullable().optional(),
  comment: cleanText(3000, 3),
  fitFeedback: z.enum(['RUNS_SMALL', 'TRUE_TO_SIZE', 'RUNS_LARGE']).nullable().optional(),
  mediaIds: z.array(uuid).max(5).optional(),
}).strict();
const createReviewSchema = reviewContentSchema.extend({
  orderItemId: uuid,
  orderNumber: z.string().trim().min(1).max(40),
}).strict();
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
}).strict();
const adminListSchema = listQuerySchema.extend({
  status: z.enum(['PENDING', 'PUBLISHED', 'REJECTED']).optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  verifiedPurchase: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(120).optional(),
}).strict();
const moderationSchema = z.object({
  status: z.enum(['PUBLISHED', 'REJECTED']),
}).strict();

const reviewMediaSelect = {
  media: { select: { url: true, mimeType: true } },
} satisfies Prisma.CommerceProductReviewMediaSelect;

const reviewSelect = {
  id: true,
  rating: true,
  title: true,
  comment: true,
  status: true,
  verifiedPurchase: true,
  fitFeedback: true,
  createdAt: true,
  updatedAt: true,
  media: { select: reviewMediaSelect, orderBy: { createdAt: 'asc' as const } },
  user: { select: { name: true, avatar: true } },
  orderItem: { select: { variantSnapshot: true } },
} satisfies Prisma.CommerceProductReviewSelect;

const adminReviewSelect = {
  ...reviewSelect,
  product: { select: { slug: true, translations: true } },
  order: { select: { orderNumber: true } },
  moderatedAt: true,
  deletedAt: true,
} satisfies Prisma.CommerceProductReviewSelect;

type ReviewRecord = Prisma.CommerceProductReviewGetPayload<{ select: typeof reviewSelect }>;

function reviewDto(review: ReviewRecord) {
  const snapshot = review.orderItem.variantSnapshot;
  const variant = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    ? snapshot as Prisma.JsonObject
    : null;
  return {
    rating: review.rating,
    title: review.title,
    comment: review.comment,
    verifiedPurchase: review.verifiedPurchase,
    fitFeedback: review.fitFeedback,
    createdAt: review.createdAt,
    author: { name: review.user.name, avatar: review.user.avatar },
    purchasedVariant: variant
      ? {
        ...(typeof variant.size === 'string' ? { size: variant.size } : {}),
        ...(typeof variant.color === 'string' ? { color: variant.color } : {}),
      }
      : null,
    media: review.media.map(({ media }) => ({ url: media.url, mimeType: media.mimeType })),
  };
}

function eligibleOrderStatus(status: string, deliveryStatus: string | null) {
  return ['DELIVERED', 'COMPLETED'].includes(status) &&
    (deliveryStatus === null || deliveryStatus === 'DELIVERED');
}

async function ownedMedia(
  tx: Prisma.TransactionClient,
  mediaIds: string[],
  userId: string,
) {
  if (new Set(mediaIds).size !== mediaIds.length) return false;
  if (!mediaIds.length) return true;
  const media = await tx.media.findMany({
    where: {
      id: { in: mediaIds },
      ownerId: userId,
      mimeType: { in: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] },
      commerceReviewMedia: { none: {} },
    },
    select: { id: true },
  });
  return media.length === mediaIds.length;
}

function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002');
}

function userRateKey(request: FastifyRequest) {
  return `${request.ip}:${request.user?.userId ?? 'anonymous'}`;
}

export const productReviewsModule: FastifyPluginAsync = async (app) => {
  app.get('/products/:slug/reviews/eligibility', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const params = z.object({ slug: z.string().min(1).max(120) }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: 'INVALID_REVIEW_QUERY' });
    const purchases = await app.prisma.commerceOrderItem.findMany({
      where: {
        product: { slug: params.data.slug },
        order: { userId: request.user.userId, status: { in: ['DELIVERED', 'COMPLETED'] } },
      },
      select: {
        id: true,
        title: true,
        variantSnapshot: true,
        order: { select: { orderNumber: true, status: true, delivery: { select: { status: true } } } },
        review: { select: { id: true, status: true, deletedAt: true } },
      },
      orderBy: { order: { createdAt: 'desc' } },
      take: 200,
    });
    return purchases
      .filter((item) => eligibleOrderStatus(item.order.status, item.order.delivery?.status ?? null))
      .map((item) => {
        const snapshot = item.variantSnapshot && typeof item.variantSnapshot === 'object' && !Array.isArray(item.variantSnapshot)
          ? item.variantSnapshot as Prisma.JsonObject
          : null;
        return {
          orderItemId: item.id,
          orderNumber: item.order.orderNumber,
          reviewId: item.review?.deletedAt ? null : item.review?.id ?? null,
          reviewStatus: item.review?.deletedAt ? null : item.review?.status ?? null,
          purchasedVariant: snapshot
            ? {
              ...(typeof snapshot.size === 'string' ? { size: snapshot.size } : {}),
              ...(typeof snapshot.color === 'string' ? { color: snapshot.color } : {}),
            }
            : null,
        };
      });
  });

  app.get('/reviews/me/:id', { preHandler: [authMiddleware] }, async (request, reply) => {
    const params = z.object({ id: uuid }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: 'INVALID_REVIEW_ID' });
    const review = await app.prisma.commerceProductReview.findFirst({
      where: { id: params.data.id, userId: request.user.userId, deletedAt: null },
      select: { ...reviewSelect, status: true },
    });
    if (!review) return reply.status(404).send({ code: 'REVIEW_NOT_FOUND' });
    return { id: review.id, status: review.status, ...reviewDto(review) };
  });

  app.get('/products/:slug/reviews', async (request, reply) => {
    const params = z.object({ slug: z.string().min(1).max(120) }).safeParse(request.params);
    const query = listQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.status(400).send({ code: 'INVALID_REVIEW_QUERY' });
    const product = await app.prisma.commerceProduct.findFirst({
      where: { slug: params.data.slug, status: 'PUBLISHED' },
      select: { id: true },
    });

    if (!product) return reply.status(404).send({ code: 'PRODUCT_NOT_FOUND' });

    const where: Prisma.CommerceProductReviewWhereInput = {
      productId: product.id,
      status: CommerceProductReviewStatus.PUBLISHED,
      deletedAt: null,
    };
    const [aggregate, ratings, fitCounts, reviews] = await Promise.all([
      app.prisma.commerceProductReview.aggregate({
        where,
        _avg: { rating: true },
        _count: { id: true },
      }),
      app.prisma.commerceProductReview.groupBy({
        by: ['rating'],
        where,
        _count: { id: true },
      }),
      app.prisma.commerceProductReview.groupBy({
        by: ['fitFeedback'],
        where: { ...where, fitFeedback: { not: null } },
        _count: { id: true },
      }),
      app.prisma.commerceProductReview.findMany({
        where,
        select: reviewSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.data.page - 1) * query.data.limit,
        take: query.data.limit,
      }),
    ]);
    const count = aggregate._count.id;
    const fitTotal = fitCounts.reduce((total, row) => total + row._count.id, 0);
    const distribution = Object.fromEntries([1, 2, 3, 4, 5].map((rating) => [
      rating,
      ratings.find((row) => row.rating === rating)?._count.id ?? 0,
    ]));
    const fitDistribution = Object.fromEntries(['RUNS_SMALL', 'TRUE_TO_SIZE', 'RUNS_LARGE'].map((fit) => [
      fit,
      fitTotal
        ? Math.round((fitCounts.find((row) => row.fitFeedback === fit)?._count.id ?? 0) * 100 / fitTotal)
        : 0,
    ]));
    return {
      summary: { averageRating: aggregate._avg.rating === null ? null : Number(aggregate._avg.rating.toFixed(1)), reviewCount: count, distribution, fitDistribution },
      items: reviews.map(reviewDto),
      pagination: { page: query.data.page, limit: query.data.limit, total: count, pages: Math.ceil(count / query.data.limit) },
    };
  });

  app.get('/products/:slug/review-eligibility/:orderItemId', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const parsed = z.object({ slug: z.string().min(1).max(120), orderItemId: uuid }).safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_REVIEW_QUERY' });
    const item = await app.prisma.commerceOrderItem.findUnique({
      where: { id: parsed.data.orderItemId },
      select: {
        id: true,
        product: { select: { id: true, slug: true } },
        variantSnapshot: true,
        order: {
          select: {
            orderNumber: true,
            userId: true,
            status: true,
            delivery: { select: { status: true } },
          },
        },
        review: { select: { id: true, status: true, deletedAt: true } },
      },
    });
    if (!item || item.product.slug !== parsed.data.slug || item.order.userId !== request.user.userId) {
      return reply.send({ eligible: false, reason: 'PURCHASE_NOT_FOUND', reviewStatus: null, orderNumber: null, purchasedVariant: null });
    }
    const eligible = eligibleOrderStatus(item.order.status, item.order.delivery?.status ?? null);
    const snapshot = item.variantSnapshot && typeof item.variantSnapshot === 'object' && !Array.isArray(item.variantSnapshot)
      ? item.variantSnapshot as Prisma.JsonObject
      : null;
    return {
      eligible,
      reason: eligible ? null : 'ORDER_NOT_DELIVERED',
      reviewId: item.review?.deletedAt ? null : item.review?.id ?? null,
      reviewStatus: item.review?.deletedAt ? null : item.review?.status ?? null,
      orderNumber: item.order.orderNumber,
      purchasedVariant: snapshot
        ? {
          ...(typeof snapshot.size === 'string' ? { size: snapshot.size } : {}),
          ...(typeof snapshot.color === 'string' ? { color: snapshot.color } : {}),
        }
        : null,
    };
  });

  app.post('/products/:slug/reviews', {
    preHandler: [authMiddleware],
    config: { rateLimit: { max: 5, timeWindow: '15 minutes', keyGenerator: userRateKey } },
  }, async (request, reply) => {
    const params = z.object({ slug: z.string().min(1).max(120) }).safeParse(request.params);
    const input = createReviewSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ code: 'INVALID_REVIEW_INPUT' });
    try {
      const review = await app.prisma.$transaction(async (tx) => {
        const item = await tx.commerceOrderItem.findUnique({
          where: { id: input.data.orderItemId },
          select: {
            id: true, orderId: true, productId: true,
            product: { select: { slug: true } },
            order: { select: { orderNumber: true, userId: true, status: true, delivery: { select: { status: true } } } },
          },
        });
        if (
          !item ||
          item.product.slug !== params.data.slug ||
          item.order.orderNumber !== input.data.orderNumber ||
          item.order.userId !== request.user.userId
        ) throw new ReviewRequestError('PURCHASE_NOT_FOUND', 403);
        if (!eligibleOrderStatus(item.order.status, item.order.delivery?.status ?? null)) {
          throw new ReviewRequestError('ORDER_NOT_DELIVERED', 409);
        }
        if (!await ownedMedia(tx, input.data.mediaIds ?? [], request.user.userId)) {
          throw new ReviewRequestError('INVALID_REVIEW_MEDIA', 400);
        }
        const previous = await tx.commerceProductReview.findUnique({
          where: { orderItemId: item.id },
          select: { id: true, userId: true, deletedAt: true, createdAt: true },
        });
        if (previous) {
          if (previous.userId !== request.user.userId || previous.deletedAt === null) {
            throw new ReviewRequestError('REVIEW_ALREADY_EXISTS', 409);
          }
          const restored = await tx.commerceProductReview.updateMany({
            where: { id: previous.id, userId: request.user.userId, deletedAt: { not: null } },
            data: {
              rating: input.data.rating,
              title: input.data.title || null,
              comment: input.data.comment,
              fitFeedback: input.data.fitFeedback ?? null,
              status: 'PENDING',
              verifiedPurchase: true,
              deletedAt: null,
              moderatedAt: null,
              moderatedById: null,
            },
          });
          if (restored.count !== 1) throw new ReviewRequestError('REVIEW_ALREADY_EXISTS', 409);
          await tx.commerceProductReviewMedia.deleteMany({ where: { reviewId: previous.id } });
          if (input.data.mediaIds?.length) await tx.commerceProductReviewMedia.createMany({
            data: input.data.mediaIds.map((mediaId) => ({ reviewId: previous.id, mediaId })),
          });
          return { id: previous.id, status: 'PENDING', createdAt: previous.createdAt };
        }
        const created = await tx.commerceProductReview.create({
          data: {
            productId: item.productId,
            userId: request.user.userId,
            orderId: item.orderId,
            orderItemId: item.id,
            rating: input.data.rating,
            title: input.data.title || null,
            comment: input.data.comment,
            fitFeedback: input.data.fitFeedback ?? null,
            status: 'PENDING',
            verifiedPurchase: true,
            ...(input.data.mediaIds?.length
              ? { media: { create: input.data.mediaIds.map((mediaId) => ({ mediaId })) } }
              : {}),
          },
          select: { id: true, status: true, createdAt: true },
        });
        return created;
      });
      return reply.status(201).send({ ...review, message: 'REVIEW_SUBMITTED' });
    } catch (error) {
      if (error instanceof ReviewRequestError) return reply.status(error.statusCode).send({ code: error.code });
      if (isUniqueConflict(error)) return reply.status(409).send({ code: 'REVIEW_ALREADY_EXISTS' });
      request.log.error({ error }, 'Unable to create product review');
      return reply.status(500).send({ code: 'REVIEW_CREATE_FAILED' });
    }
  });

  app.patch('/reviews/me/:id', {
    preHandler: [authMiddleware],
    config: { rateLimit: { max: 10, timeWindow: '15 minutes', keyGenerator: userRateKey } },
  }, async (request, reply) => {
    const params = z.object({ id: uuid }).safeParse(request.params);
    const input = reviewContentSchema.partial().safeParse(request.body);
    if (!params.success || !input.success || !Object.keys(input.data).length) {
      return reply.status(400).send({ code: 'INVALID_REVIEW_INPUT' });
    }
    try {
      const result = await app.prisma.$transaction(async (tx) => {
        const current = await tx.commerceProductReview.findFirst({
          where: { id: params.data.id, userId: request.user.userId, deletedAt: null },
          select: { id: true, status: true },
        });
        if (!current) return { error: 'REVIEW_NOT_FOUND' as const };
        const mediaIds = input.data.mediaIds;
        if (mediaIds !== undefined && !await ownedMedia(tx, mediaIds, request.user.userId)) {
          return { error: 'INVALID_REVIEW_MEDIA' as const };
        }
        const changed = await tx.commerceProductReview.updateMany({
          where: { id: current.id, userId: request.user.userId, deletedAt: null },
          data: {
            ...(input.data.rating !== undefined ? { rating: input.data.rating } : {}),
            ...(input.data.title !== undefined ? { title: input.data.title || null } : {}),
            ...(input.data.comment !== undefined ? { comment: input.data.comment } : {}),
            ...(input.data.fitFeedback !== undefined ? { fitFeedback: input.data.fitFeedback } : {}),
            ...(['PUBLISHED', 'REJECTED'].includes(current.status)
              ? { status: 'PENDING', moderatedAt: null, moderatedById: null }
              : {}),
          },
        });
        if (changed.count !== 1) return { error: 'REVIEW_NOT_FOUND' as const };
        if (mediaIds !== undefined) {
          await tx.commerceProductReviewMedia.deleteMany({ where: { reviewId: current.id } });
          if (mediaIds.length) await tx.commerceProductReviewMedia.createMany({
            data: mediaIds.map((mediaId) => ({ reviewId: current.id, mediaId })),
          });
        }
        return { status: ['PUBLISHED', 'REJECTED'].includes(current.status) ? 'PENDING' : current.status };
      });
      if ('error' in result) return reply.status(result.error === 'REVIEW_NOT_FOUND' ? 404 : 400).send({ code: result.error });
      return { status: result.status, message: 'REVIEW_UPDATED' };
    } catch (error) {
      if (isUniqueConflict(error)) return reply.status(409).send({ code: 'REVIEW_MEDIA_ALREADY_USED' });
      request.log.error({ error }, 'Unable to update product review');
      return reply.status(500).send({ code: 'REVIEW_UPDATE_FAILED' });
    }
  });

  app.delete('/reviews/me/:id', {
    preHandler: [authMiddleware],
    config: { rateLimit: { max: 5, timeWindow: '15 minutes', keyGenerator: userRateKey } },
  }, async (request, reply) => {
    const params = z.object({ id: uuid }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: 'INVALID_REVIEW_ID' });
    const result = await app.prisma.commerceProductReview.updateMany({
      where: { id: params.data.id, userId: request.user.userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count !== 1) return reply.status(404).send({ code: 'REVIEW_NOT_FOUND' });
    return reply.status(204).send();
  });

  app.get('/admin/reviews', { preHandler: adminMiddleware }, async (request, reply) => {
    const query = adminListSchema.safeParse(request.query);
    if (!query.success) return reply.status(400).send({ code: 'INVALID_REVIEW_QUERY' });
    const { page, limit, status, rating, verifiedPurchase, q } = query.data;
    const where: Prisma.CommerceProductReviewWhereInput = {
      deletedAt: null,
      ...(status ? { status } : {}),
      ...(rating ? { rating } : {}),
      ...(verifiedPurchase ? { verifiedPurchase: verifiedPurchase === 'true' } : {}),
      ...(q ? { OR: [
        { product: { slug: { contains: q, mode: 'insensitive' } } },
        { user: { name: { contains: q, mode: 'insensitive' } } },
        { order: { orderNumber: { contains: q, mode: 'insensitive' } } },
      ] } : {}),
    };
    const [total, items] = await Promise.all([
      app.prisma.commerceProductReview.count({ where }),
      app.prisma.commerceProductReview.findMany({
        where,
        select: adminReviewSelect,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return {
      items: items.map((review) => ({
        id: review.id,
        product: review.product,
        orderNumber: review.order.orderNumber,
        status: review.status,
        rating: review.rating,
        title: review.title,
        comment: review.comment,
        verifiedPurchase: review.verifiedPurchase,
        fitFeedback: review.fitFeedback,
        customer: review.user,
        media: review.media.map(({ media }) => ({ url: media.url, mimeType: media.mimeType })),
        createdAt: review.createdAt,
        moderatedAt: review.moderatedAt,
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  });

  app.patch('/admin/reviews/:id/moderation', { preHandler: adminMiddleware }, async (request, reply) => {
    const params = z.object({ id: uuid }).safeParse(request.params);
    const input = moderationSchema.safeParse(request.body);
    if (!params.success || !input.success) return reply.status(400).send({ code: 'INVALID_MODERATION_INPUT' });
    try {
      const result = await app.prisma.$transaction(async (tx) => {
        const current = await tx.commerceProductReview.findFirst({
          where: { id: params.data.id, deletedAt: null },
          select: { id: true, status: true, productId: true },
        });
        if (!current) return { error: 'REVIEW_NOT_FOUND' as const };
        const valid = current.status === 'PENDING' ||
          (current.status === 'PUBLISHED' && input.data.status === 'REJECTED');
        if (!valid) return { error: 'INVALID_MODERATION_TRANSITION' as const };
        const moderatedAt = new Date();
        const update = await tx.commerceProductReview.updateMany({
          where: { id: current.id, status: current.status, deletedAt: null },
          data: { status: input.data.status, moderatedAt, moderatedById: request.user.userId },
        });
        if (update.count !== 1) return { error: 'INVALID_MODERATION_TRANSITION' as const };
        await tx.auditLog.create({
          data: {
            userId: request.user.userId,
            action: input.data.status === 'PUBLISHED' ? 'PRODUCT_REVIEW_PUBLISHED' : 'PRODUCT_REVIEW_REJECTED',
            resource: 'CommerceProductReview',
            resourceId: current.id,
            meta: { previousStatus: current.status, status: input.data.status, productId: current.productId },
          },
        });
        return { status: input.data.status, moderatedAt };
      });
      if ('error' in result) {
        const statusCode = result.error === 'REVIEW_NOT_FOUND' ? 404 : 409;
        return reply.status(statusCode).send({ code: result.error });
      }
      return result;
    } catch (error) {
      request.log.error({ error }, 'Unable to moderate product review');
      return reply.status(500).send({ code: 'REVIEW_MODERATION_FAILED' });
    }
  });
};

class ReviewRequestError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code);
  }
}
