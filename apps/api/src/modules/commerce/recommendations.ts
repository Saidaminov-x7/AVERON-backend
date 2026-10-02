import { createHash, randomBytes } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma, ProductPublicationStatus } from '@prisma/client';
import { z } from 'zod';
import { config } from '../../config';
import { authMiddleware } from '../../lib/authMiddleware';
import { featureFlags } from '../features/feature-flags';
import { publicProductDto } from './public-product-dto';
import {
  isEligibleRecommendationProduct,
  rankRecommendations,
  RECENT_HISTORY_LIMIT,
  RECENT_HISTORY_RETENTION_DAYS,
  RECOMMENDATION_CANDIDATE_LIMIT,
  RECOMMENDATION_LIMIT,
  recommendationAvailability,
} from './recommendation-ranking';

const anonymousCookieName = 'averonRecommendationSession';
const anonymousCookiePattern = /^[A-Za-z0-9_-]{43}$/;
const requestSchema = z.object({
  strategy: z.enum(['related', 'you-may-also-like', 'personalized']).default('related'),
  limit: z.coerce.number().int().min(1).max(RECOMMENDATION_LIMIT).default(8),
}).strict();
const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(RECOMMENDATION_LIMIT).default(8),
  exclude: z.string().trim().min(1).max(160).optional(),
}).strict();
const viewSchema = z.object({ slug: z.string().trim().min(1).max(160) }).strict();

const productInclude = {
  images: { orderBy: { sortOrder: 'asc' as const }, take: 3 },
  variants: { where: { active: true } },
  category: true,
  reviews: {
    where: { status: 'PUBLISHED' as const, deletedAt: null },
    select: { rating: true },
    take: 20,
  },
} satisfies Prisma.CommerceProductInclude;

type RecommendationProduct = Prisma.CommerceProductGetPayload<{ include: typeof productInclude }>;

type RecommendationOwner = { userId: string } | { sessionKey: string };
type IdentityResult = RecommendationOwner | false;

function ownerWhere(owner: RecommendationOwner): Prisma.CommerceRecentlyViewedProductWhereInput {
  return 'userId' in owner ? { userId: owner.userId } : { sessionKey: owner.sessionKey };
}

function publicRecommendation(product: RecommendationProduct) {
  const { reviews: _reviews, ...canonical } = product;
  return {
    ...publicProductDto(canonical),
    recommendationAvailability: recommendationAvailability(product),
  };
}

function ensureAnonymousSession(request: FastifyRequest, reply: FastifyReply): string {
  const cookieValue = request.cookies?.[anonymousCookieName];
  const sessionId = cookieValue && anonymousCookiePattern.test(cookieValue)
    ? cookieValue
    : randomBytes(32).toString('base64url');
  if (sessionId !== cookieValue) {
    reply.setCookie(anonymousCookieName, sessionId, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
  }
  return createHash('sha256').update(sessionId).digest('hex');
}

async function identifyOwner(request: FastifyRequest, reply: FastifyReply): Promise<IdentityResult> {
  const suppliedCredential = Boolean(request.headers.authorization || request.cookies?.accessToken);
  if (suppliedCredential) {
    try {
      await request.jwtVerify();
      if (request.user?.userId) return { userId: request.user.userId };
      reply.status(401).send({ code: 'UNAUTHORIZED' });
      return false;
    } catch {
      reply.status(401).send({ code: 'UNAUTHORIZED' });
      return false;
    }
  }
  return { sessionKey: ensureAnonymousSession(request, reply) };
}

function recommendableWhere(): Prisma.CommerceProductWhereInput {
  return {
    status: ProductPublicationStatus.PUBLISHED,
    category: { active: true },
  };
}

function isAvailable(product: RecommendationProduct): boolean {
  return isEligibleRecommendationProduct(product);
}

function productMetadata(product: RecommendationProduct): string {
  return JSON.stringify({
    translations: product.translations,
    attributes: product.attributes,
    material: product.material,
    category: product.category?.name,
    colors: product.variants.map((variant) => variant.color),
  }).toLocaleLowerCase();
}

function responseReason(strategy: string, personalized: boolean): string {
  if (strategy === 'related') return 'RELATED_CATEGORY';
  if (personalized) return 'BASED_ON_YOUR_INTERESTS';
  return 'RELATED_CATEGORY';
}

export interface RecommendationFlags {
  isEnabled(flag: 'RECOMMENDATIONS' | 'PERSONALIZED_RECOMMENDATIONS' | 'RECENTLY_VIEWED'): boolean;
}

export function createRecommendationsModule(dependencies: {
  flags?: RecommendationFlags;
} = {}): FastifyPluginAsync {
  const flags = dependencies.flags ?? featureFlags;
  let lastGlobalRetentionCleanup = 0;

  return async (app) => {
    app.get<{ Params: { slug: string } }>('/products/:slug/recommendations', {
      config: { rateLimit: { max: 60, timeWindow: '1 minute', skipOnError: false } },
    }, async (request, reply) => {
      if (!flags.isEnabled('RECOMMENDATIONS')) {
        return reply.status(403).send({ code: 'FEATURE_DISABLED' });
      }
      const parsed = requestSchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ code: 'INVALID_RECOMMENDATION_REQUEST' });
      const startedAt = Date.now();
      const base = await app.prisma.commerceProduct.findFirst({
        where: {
          slug: request.params.slug,
          status: ProductPublicationStatus.PUBLISHED,
          category: { active: true },
        },
        include: productInclude,
      });
      if (!base) return reply.status(404).send({ code: 'PRODUCT_NOT_FOUND' });

      let strategy: 'RELATED' | 'YOU_MAY_ALSO_LIKE' | 'PERSONALIZED' =
        parsed.data.strategy === 'related'
          ? 'RELATED'
          : parsed.data.strategy === 'personalized'
            ? 'PERSONALIZED'
            : 'YOU_MAY_ALSO_LIKE';
      let userId: string | undefined;
      if (strategy === 'PERSONALIZED') {
        if (!flags.isEnabled('PERSONALIZED_RECOMMENDATIONS')) {
          return reply.status(403).send({ code: 'FEATURE_DISABLED' });
        }
        const auth = await identifyOwner(request, reply);
        if (auth === false) return reply;
        if ('userId' in auth) userId = auth.userId;
        else strategy = 'YOU_MAY_ALSO_LIKE';
      }

      const candidates = await app.prisma.commerceProduct.findMany({
        where: {
          ...recommendableWhere(),
          id: { not: base.id },
        },
        include: productInclude,
        orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
        take: RECOMMENDATION_CANDIDATE_LIMIT,
      });
      const eligible = candidates.filter(isAvailable);
      const recentViews = userId
        ? await app.prisma.commerceRecentlyViewedProduct.findMany({
            where: { userId, product: recommendableWhere() },
            select: { productId: true, product: { select: { categoryId: true } } },
            orderBy: { viewedAt: 'desc' },
            take: RECENT_HISTORY_LIMIT,
          })
        : [];
      const favorites = userId
        ? await app.prisma.productFavorite.findMany({
            where: { userId, product: recommendableWhere() },
            select: { productId: true, product: { select: { categoryId: true } } },
            take: 40,
          })
        : [];
      const viewedProductIds = new Set(recentViews.map((item) => item.productId));
      const interestedCategoryIds = new Set([
        ...recentViews.map((item) => item.product.categoryId),
        ...favorites.map((item) => item.product.categoryId),
      ].filter((id): id is string => Boolean(id)));
      const favoriteProductIds = new Set(favorites.map((item) => item.productId));
      const rows = rankRecommendations(eligible, {
        strategy,
        baseProductId: base.id,
        baseCategoryId: base.categoryId,
        baseParentCategoryId: base.category?.parentId,
        baseMetadata: productMetadata(base),
        ...(userId ? { viewedProductIds, interestedCategoryIds, favoriteProductIds } : {}),
      }, parsed.data.limit);
      const personalized = strategy === 'PERSONALIZED' && Boolean(userId) &&
        (recentViews.length > 0 || favorites.length > 0);
      const items = rows.map((row) => ({
        product: publicRecommendation(row.product),
        reasonCode: row.reasonCode,
      }));
      request.log.info({
        operation: 'product_recommendations',
        strategy,
        durationMs: Date.now() - startedAt,
        candidateCount: candidates.length,
        resultCount: items.length,
        personalized,
        fallbackUsed: strategy === 'PERSONALIZED' && !personalized,
      });
      return reply.send({
        items,
        meta: {
          strategy,
          personalized,
          fallbackUsed: strategy === 'PERSONALIZED' && !personalized,
          reasonCode: responseReason(parsed.data.strategy, personalized),
        },
      });
    });

    app.post('/recommendations/recently-viewed', {
      config: { rateLimit: { max: 30, timeWindow: '1 minute', skipOnError: false } },
    }, async (request, reply) => {
      if (!flags.isEnabled('RECENTLY_VIEWED')) {
        return reply.status(403).send({ code: 'FEATURE_DISABLED' });
      }
      const parsed = viewSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ code: 'INVALID_VIEW_EVENT' });
      const owner = await identifyOwner(request, reply);
      if (owner === false) return reply;
      const product = await app.prisma.commerceProduct.findFirst({
        where: {
          slug: parsed.data.slug,
          status: ProductPublicationStatus.PUBLISHED,
          category: { active: true },
        },
        include: productInclude,
      });
      if (!product || !isAvailable(product)) {
        return reply.status(404).send({ code: 'PRODUCT_NOT_FOUND' });
      }
      const ownerSelector = ownerWhere(owner);
      const compoundKey = 'userId' in owner
        ? { userId_productId: { userId: owner.userId, productId: product.id } }
        : { sessionKey_productId: { sessionKey: owner.sessionKey, productId: product.id } };
      const cutoff = new Date(Date.now() - RECENT_HISTORY_RETENTION_DAYS * 86_400_000);
      await app.prisma.commerceRecentlyViewedProduct.deleteMany({
        where: { ...ownerSelector, viewedAt: { lt: cutoff } },
      });
      if (Date.now() - lastGlobalRetentionCleanup >= 60 * 60 * 1000) {
        await app.prisma.commerceRecentlyViewedProduct.deleteMany({
          where: { viewedAt: { lt: cutoff } },
        });
        lastGlobalRetentionCleanup = Date.now();
      }
      await app.prisma.commerceRecentlyViewedProduct.upsert({
        where: compoundKey,
        create: {
          ...owner,
          productId: product.id,
        },
        update: { viewedAt: new Date() },
      });
      const retained = await app.prisma.commerceRecentlyViewedProduct.findMany({
        where: ownerSelector,
        orderBy: { viewedAt: 'desc' },
        take: RECENT_HISTORY_LIMIT,
        select: { id: true },
      });
      await app.prisma.commerceRecentlyViewedProduct.deleteMany({
        where: {
          ...ownerSelector,
          id: { notIn: retained.map((item) => item.id) },
        },
      });
      return reply.status(202).send({ recorded: true });
    });

    app.get('/recommendations/recently-viewed', {
      config: { rateLimit: { max: 60, timeWindow: '1 minute', skipOnError: false } },
    }, async (request, reply) => {
      if (!flags.isEnabled('RECENTLY_VIEWED')) {
        return reply.status(403).send({ code: 'FEATURE_DISABLED' });
      }
      const parsed = historyQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.status(400).send({ code: 'INVALID_RECOMMENDATION_REQUEST' });
      const owner = await identifyOwner(request, reply);
      if (owner === false) return reply;
      const cutoff = new Date(Date.now() - RECENT_HISTORY_RETENTION_DAYS * 86_400_000);
      const viewed = await app.prisma.commerceRecentlyViewedProduct.findMany({
        where: {
          ...ownerWhere(owner),
          viewedAt: { gte: cutoff },
          product: recommendableWhere(),
        },
        include: { product: { include: productInclude } },
        orderBy: { viewedAt: 'desc' },
        take: RECENT_HISTORY_LIMIT,
      });
      const items = viewed
        .filter(({ product }) =>
          product.slug !== parsed.data.exclude &&
          isAvailable(product),
        )
        .slice(0, parsed.data.limit)
        .map(({ product }) => ({ product: publicRecommendation(product), reasonCode: 'BASED_ON_RECENT_VIEWS' }));
      return reply.send({ items, meta: { personalized: 'userId' in owner, limit: parsed.data.limit } });
    });

    app.delete('/recommendations/recently-viewed', async (request, reply) => {
      if (!flags.isEnabled('RECENTLY_VIEWED')) {
        return reply.status(403).send({ code: 'FEATURE_DISABLED' });
      }
      const owner = await identifyOwner(request, reply);
      if (owner === false) return reply;
      await app.prisma.commerceRecentlyViewedProduct.deleteMany({ where: ownerWhere(owner) });
      return reply.send({ cleared: true });
    });

    app.get('/recommendations/personalized', { preHandler: authMiddleware }, async (request, reply) => {
      if (!flags.isEnabled('PERSONALIZED_RECOMMENDATIONS')) {
        return reply.status(403).send({ code: 'FEATURE_DISABLED' });
      }
      const recent = await app.prisma.commerceRecentlyViewedProduct.findMany({
        where: { userId: request.user.userId, product: recommendableWhere() },
        select: { product: { select: { slug: true } } },
        orderBy: { viewedAt: 'desc' },
        take: 1,
      });
      const seedSlug = recent[0]?.product.slug;
      if (!seedSlug) {
        const candidates = await app.prisma.commerceProduct.findMany({
          where: recommendableWhere(),
          include: productInclude,
          orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
          take: RECOMMENDATION_CANDIDATE_LIMIT,
        });
        const items = rankRecommendations(candidates.filter(isAvailable), {
          strategy: 'PERSONALIZED',
        }, 8).map((row) => ({
          product: publicRecommendation(row.product),
          reasonCode: 'POPULAR_IN_CATEGORY',
        }));
        return reply.send({ items, meta: { personalized: false, fallbackUsed: true } });
      }
      const seed = await app.prisma.commerceProduct.findFirst({
        where: { slug: seedSlug, status: ProductPublicationStatus.PUBLISHED, category: { active: true } },
        include: productInclude,
      });
      if (!seed) return reply.send({ items: [], meta: { personalized: false, fallbackUsed: true } });
      const candidates = await app.prisma.commerceProduct.findMany({
        where: { ...recommendableWhere(), id: { not: seed.id } },
        include: productInclude,
        orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
        take: RECOMMENDATION_CANDIDATE_LIMIT,
      });
      const viewed = await app.prisma.commerceRecentlyViewedProduct.findMany({
        where: { userId: request.user.userId, product: recommendableWhere() },
        select: { productId: true, product: { select: { categoryId: true } } },
        orderBy: { viewedAt: 'desc' },
        take: RECENT_HISTORY_LIMIT,
      });
      const favorites = await app.prisma.productFavorite.findMany({
        where: { userId: request.user.userId, product: recommendableWhere() },
        select: { productId: true, product: { select: { categoryId: true } } },
        take: 40,
      });
      const rows = rankRecommendations(candidates.filter(isAvailable), {
        strategy: 'PERSONALIZED',
        baseProductId: seed.id,
        baseCategoryId: seed.categoryId,
        baseParentCategoryId: seed.category?.parentId,
        baseMetadata: productMetadata(seed),
        viewedProductIds: new Set(viewed.map((row) => row.productId)),
        interestedCategoryIds: new Set([
          ...viewed.map((row) => row.product.categoryId),
          ...favorites.map((row) => row.product.categoryId),
        ].filter((id): id is string => Boolean(id))),
        favoriteProductIds: new Set(favorites.map((row) => row.productId)),
      }, 8);
      return reply.send({
        items: rows.map((row) => ({
          product: publicRecommendation(row.product),
          reasonCode: row.reasonCode,
        })),
        meta: { personalized: viewed.length > 0 || favorites.length > 0, fallbackUsed: !viewed.length && !favorites.length },
      });
    });
  };
}
