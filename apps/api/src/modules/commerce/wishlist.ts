import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../../lib/authMiddleware';

const favoriteParams = z.object({ productId: z.string().uuid() });
const shareTokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const publicProductSelect = {
  id: true,
  slug: true,
  translations: true,
  salePriceUzs: true,
  stock: true,
  preorderEnabled: true,
  preorderLimit: true,
  preorderReserved: true,
  images: { orderBy: { sortOrder: 'asc' as const }, take: 1, select: { url: true } },
} as const;

function productDto(product: {
  id: string;
  slug: string;
  translations: unknown;
  salePriceUzs: { toString(): string };
  stock: number;
  preorderEnabled: boolean;
  preorderLimit: number;
  preorderReserved: number;
  images: Array<{ url: string }>;
}) {
  const translations = product.translations && typeof product.translations === 'object'
    ? product.translations as Record<string, unknown>
    : {};
  const title = ['ru', 'uz', 'en'].map((locale) => {
    const entry = translations[locale];
    if (typeof entry === 'string') return entry;
    return entry && typeof entry === 'object' && 'title' in entry ? entry.title : undefined;
  }).find((entry): entry is string => typeof entry === 'string') ?? '';
  return {
    id: product.id,
    slug: product.slug,
    title,
    imageUrl: product.images[0]?.url ?? null,
    priceUzs: product.salePriceUzs.toString(),
    available: product.stock > 0 || (
      product.preorderEnabled && product.preorderReserved < product.preorderLimit
    ),
  };
}

function newShareToken(): string {
  return randomBytes(32).toString('base64url');
}

export const wishlistModule: FastifyPluginAsync = async (app) => {
  app.get('/wishlist', { preHandler: authMiddleware }, async (request) => {
    const [favorites, owner] = await Promise.all([
      app.prisma.productFavorite.findMany({
        where: { userId: request.user.userId, product: { status: 'PUBLISHED' } },
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { product: { select: publicProductSelect } },
      }),
      app.prisma.user.findUnique({
        where: { id: request.user.userId },
        select: { wishlistShareToken: true },
      }),
    ]);
    return {
      items: favorites.map(({ product }) => productDto(product)),
      sharingEnabled: Boolean(owner?.wishlistShareToken),
      sharePath: owner?.wishlistShareToken ? `/wishlists/shared/${owner.wishlistShareToken}` : null,
    };
  });

  app.post<{ Params: { productId: string } }>('/wishlist/:productId', {
    preHandler: authMiddleware,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const parsed = favoriteParams.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_PRODUCT_ID', message: 'Invalid product ID' });
    const product = await app.prisma.commerceProduct.findFirst({
      where: { id: parsed.data.productId, status: 'PUBLISHED' },
      select: { id: true },
    });
    if (!product) return reply.status(404).send({ code: 'PRODUCT_NOT_AVAILABLE', message: 'Product is unavailable' });
    const count = await app.prisma.productFavorite.count({ where: { userId: request.user.userId } });
    if (count >= 100) return reply.status(409).send({ code: 'WISHLIST_LIMIT_REACHED', message: 'Wishlist limit reached' });
    await app.prisma.productFavorite.upsert({
      where: { userId_productId: { userId: request.user.userId, productId: product.id } },
      create: { userId: request.user.userId, productId: product.id },
      update: {},
    });
    return reply.status(204).send();
  });

  app.delete<{ Params: { productId: string } }>('/wishlist/:productId', { preHandler: authMiddleware }, async (request, reply) => {
    const parsed = favoriteParams.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_PRODUCT_ID', message: 'Invalid product ID' });
    await app.prisma.productFavorite.deleteMany({
      where: { userId: request.user.userId, productId: parsed.data.productId },
    });
    return reply.status(204).send();
  });

  app.post('/wishlist/sharing', { preHandler: authMiddleware }, async (request, reply) => {
    const current = await app.prisma.user.findUnique({
      where: { id: request.user.userId },
      select: { wishlistShareToken: true },
    });
    if (current?.wishlistShareToken) {
      return reply.send({ enabled: true, sharePath: `/wishlists/shared/${current.wishlistShareToken}` });
    }
    const token = newShareToken();
    try {
      const owner = await app.prisma.user.update({
        where: { id: request.user.userId },
        data: { wishlistShareToken: token },
        select: { wishlistShareToken: true },
      });
      return reply.send({ enabled: true, sharePath: `/wishlists/shared/${owner.wishlistShareToken}` });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error &&
          (error as { code: string }).code === 'P2002') {
        request.log.error('Wishlist share token collision');
      }
      throw error;
    }
  });

  app.post('/wishlist/sharing/regenerate', { preHandler: authMiddleware }, async (request, reply) => {
    const owner = await app.prisma.user.update({
      where: { id: request.user.userId },
      data: { wishlistShareToken: newShareToken() },
      select: { wishlistShareToken: true },
    });
    return reply.send({ enabled: true, sharePath: `/wishlists/shared/${owner.wishlistShareToken}` });
  });

  app.delete('/wishlist/sharing', { preHandler: authMiddleware }, async (request, reply) => {
    await app.prisma.user.update({
      where: { id: request.user.userId },
      data: { wishlistShareToken: null },
      select: { id: true },
    });
    return reply.status(204).send();
  });

  app.get<{ Params: { token: string } }>('/wishlists/shared/:token', async (request, reply) => {
    const parsed = shareTokenParams.safeParse(request.params);
    if (!parsed.success) return reply.status(404).send({ code: 'SHARED_WISHLIST_NOT_FOUND', message: 'Shared wishlist not found' });
    const owner = await app.prisma.user.findFirst({
      where: { wishlistShareToken: parsed.data.token, isDeleted: false, isBlocked: false },
      select: {
        id: true,
        productFavorites: {
          where: { product: { status: 'PUBLISHED' } },
          orderBy: { createdAt: 'desc' },
          take: 100,
          include: { product: { select: publicProductSelect } },
        },
      },
    });
    if (!owner) return reply.status(404).send({ code: 'SHARED_WISHLIST_NOT_FOUND', message: 'Shared wishlist not found' });
    return { items: owner.productFavorites.map(({ product }) => productDto(product)) };
  });
};
