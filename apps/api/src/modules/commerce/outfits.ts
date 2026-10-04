import type { FastifyPluginAsync } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { authMiddleware } from '../../lib/authMiddleware';

const MAX_OUTFIT_ITEMS = 12;
const outfitItemSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().nullable().optional(),
}).strict();
const itemListSchema = z.array(outfitItemSchema).max(MAX_OUTFIT_ITEMS);
const createOutfitSchema = z.object({
  name: z.string().trim().min(1).max(80).default('My outfit'),
  items: itemListSchema.default([]),
}).strict();
const updateOutfitSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  items: itemListSchema.optional(),
}).strict().refine((value) => value.name !== undefined || value.items !== undefined);
const outfitParamsSchema = z.object({ outfitId: z.string().uuid() });

type Db = PrismaClient | Prisma.TransactionClient;
type ItemInput = z.infer<typeof outfitItemSchema>;

function identityKey(item: ItemInput): string {
  return `${item.productId}:${item.variantId ?? 'none'}`;
}

async function validateItems(db: Db, input: ItemInput[]) {
  if (new Set(input.map(identityKey)).size !== input.length) {
    return { error: 'DUPLICATE_OUTFIT_ITEM' as const };
  }
  const products = await db.commerceProduct.findMany({
    where: { id: { in: [...new Set(input.map((item) => item.productId))] }, status: 'PUBLISHED' },
    select: {
      id: true,
      publicId: true,
      translations: true,
      salePriceUzs: true,
      stock: true,
      preorderEnabled: true,
      preorderLimit: true,
      preorderReserved: true,
      images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } },
      variants: {
        where: { active: true },
        select: { id: true, productId: true, color: true, size: true, salePriceUzs: true, stock: true },
      },
    },
  });
  const byId = new Map(products.map((product) => [product.id, product]));
  for (const item of input) {
    const product = byId.get(item.productId);
    if (!product) return { error: 'PRODUCT_NOT_AVAILABLE' as const };
    const variant = item.variantId
      ? product.variants.find((candidate) => candidate.id === item.variantId)
      : undefined;
    if ((item.variantId && !variant) || (!item.variantId && product.variants.length > 0)) {
      return { error: 'VARIANT_NOT_AVAILABLE' as const };
    }
    const stock = variant?.stock ?? product.stock;
    const preorderAvailable = Math.max(0, product.preorderLimit - product.preorderReserved);
    if (stock < 1 && (!product.preorderEnabled || preorderAvailable < 1)) {
      return { error: 'INSUFFICIENT_STOCK' as const };
    }
  }
  return { products, byId };
}

function itemDto(item: {
  productId: string;
  variantId: string | null;
  sortOrder: number;
  product: {
    slug: string;
    publicId: string | null;
    translations: Prisma.JsonValue;
    salePriceUzs: Prisma.Decimal;
    stock: number;
    preorderEnabled: boolean;
    preorderLimit: number;
    preorderReserved: number;
    images: Array<{ url: string }>;
    variants: Array<{ id: string; color: string | null; size: string | null; salePriceUzs: Prisma.Decimal; stock: number }>;
  };
}) {
  const variant = item.variantId ? item.product.variants.find((entry) => entry.id === item.variantId) : undefined;
  const translations = item.product.translations;
  const title = translations && typeof translations === 'object' && !Array.isArray(translations)
    ? Object.values(translations as Record<string, unknown>).find((value) => typeof value === 'string')
      ?? Object.values(translations as Record<string, unknown>).map((value) =>
        value && typeof value === 'object' && 'title' in value ? value.title : undefined,
      ).find((value) => typeof value === 'string')
    : undefined;
  return {
    productId: item.productId,
    variantId: item.variantId,
    sortOrder: item.sortOrder,
    product: {
      slug: item.product.slug,
      publicId: item.product.publicId,
      title: typeof title === 'string' ? title : '',
      imageUrl: item.product.images[0]?.url ?? null,
      priceUzs: String(variant?.salePriceUzs ?? item.product.salePriceUzs),
      stock: variant?.stock ?? item.product.stock,
      preorderAvailable: item.product.preorderEnabled &&
        item.product.preorderReserved < item.product.preorderLimit,
      variant: variant ? { id: variant.id, color: variant.color, size: variant.size } : null,
    },
  };
}

const savedOutfitInclude = {
  items: {
    where: { product: { is: { status: 'PUBLISHED' as const } } },
    orderBy: { sortOrder: 'asc' as const },
    include: {
      product: {
        select: {
          slug: true,
          publicId: true,
          translations: true,
          salePriceUzs: true,
          stock: true,
          preorderEnabled: true,
          preorderLimit: true,
          preorderReserved: true,
          images: { orderBy: { sortOrder: 'asc' as const }, take: 1, select: { url: true } },
          variants: { where: { active: true }, select: { id: true, color: true, size: true, salePriceUzs: true, stock: true } },
        },
      },
    },
  },
} satisfies Prisma.OutfitInclude;

export const outfitsModule: FastifyPluginAsync = async (app) => {
  app.get('/outfits', { preHandler: authMiddleware }, async (request) => {
    const outfits = await app.prisma.outfit.findMany({
      where: { userId: request.user.userId },
      include: savedOutfitInclude,
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
    return outfits.map((outfit) => ({
      id: outfit.id,
      name: outfit.name,
      updatedAt: outfit.updatedAt,
      items: outfit.items.map(itemDto),
      totalUzs: outfit.items.reduce((sum, item) => {
        const variant = item.variantId ? item.product.variants.find((entry) => entry.id === item.variantId) : undefined;
        return sum + Number(variant?.salePriceUzs ?? item.product.salePriceUzs);
      }, 0).toFixed(2),
    }));
  });

  app.post('/outfits', { preHandler: authMiddleware }, async (request, reply) => {
    const parsed = createOutfitSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_OUTFIT', message: 'Invalid outfit' });
    const validated = await validateItems(app.prisma, parsed.data.items);
    if ('error' in validated) return reply.status(409).send({ code: validated.error, message: validated.error });
    const outfit = await app.prisma.outfit.create({
      data: {
        userId: request.user.userId,
        name: parsed.data.name,
        items: { create: parsed.data.items.map((item, sortOrder) => ({ ...item, variantId: item.variantId ?? null, sortOrder })) },
      },
      include: savedOutfitInclude,
    });
    return reply.status(201).send({ id: outfit.id, name: outfit.name, items: outfit.items.map(itemDto) });
  });

  app.get<{ Params: { outfitId: string } }>('/outfits/:outfitId', { preHandler: authMiddleware }, async (request, reply) => {
    const params = outfitParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: 'INVALID_OUTFIT_ID', message: 'Invalid outfit ID' });
    const outfit = await app.prisma.outfit.findFirst({
      where: { id: params.data.outfitId, userId: request.user.userId },
      include: savedOutfitInclude,
    });
    if (!outfit) return reply.status(404).send({ code: 'OUTFIT_NOT_FOUND', message: 'Outfit not found' });
    return {
      id: outfit.id,
      name: outfit.name,
      updatedAt: outfit.updatedAt,
      items: outfit.items.map(itemDto),
      totalUzs: outfit.items.reduce((sum, item) => {
        const variant = item.variantId ? item.product.variants.find((entry) => entry.id === item.variantId) : undefined;
        return sum + Number(variant?.salePriceUzs ?? item.product.salePriceUzs);
      }, 0).toFixed(2),
    };
  });

  app.patch<{ Params: { outfitId: string } }>('/outfits/:outfitId', { preHandler: authMiddleware }, async (request, reply) => {
    const params = outfitParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: 'INVALID_OUTFIT_ID', message: 'Invalid outfit ID' });
    const parsed = updateOutfitSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_OUTFIT', message: 'Invalid outfit update' });
    const owned = await app.prisma.outfit.findFirst({
      where: { id: params.data.outfitId, userId: request.user.userId },
      select: { id: true },
    });
    if (!owned) return reply.status(404).send({ code: 'OUTFIT_NOT_FOUND', message: 'Outfit not found' });
    if (parsed.data.items) {
      const validated = await validateItems(app.prisma, parsed.data.items);
      if ('error' in validated) return reply.status(409).send({ code: validated.error, message: validated.error });
    }
    const outfit = await app.prisma.$transaction(async (tx) => {
      if (parsed.data.items) await tx.outfitItem.deleteMany({ where: { outfitId: owned.id } });
      return tx.outfit.update({
        where: { id: owned.id },
        data: {
          ...(parsed.data.name ? { name: parsed.data.name } : {}),
          ...(parsed.data.items ? {
            items: { create: parsed.data.items.map((item, sortOrder) => ({ ...item, variantId: item.variantId ?? null, sortOrder })) },
          } : {}),
        },
        include: savedOutfitInclude,
      });
    });
    return { id: outfit.id, name: outfit.name, items: outfit.items.map(itemDto) };
  });

  app.delete<{ Params: { outfitId: string } }>('/outfits/:outfitId', { preHandler: authMiddleware }, async (request, reply) => {
    const params = outfitParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: 'INVALID_OUTFIT_ID', message: 'Invalid outfit ID' });
    const deleted = await app.prisma.outfit.deleteMany({
      where: { id: params.data.outfitId, userId: request.user.userId },
    });
    if (!deleted.count) return reply.status(404).send({ code: 'OUTFIT_NOT_FOUND', message: 'Outfit not found' });
    return reply.status(204).send();
  });

  app.post<{ Params: { outfitId: string } }>('/outfits/:outfitId/cart', {
    preHandler: authMiddleware,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const params = outfitParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ code: 'INVALID_OUTFIT_ID', message: 'Invalid outfit ID' });
    const outfit = await app.prisma.outfit.findFirst({
      where: { id: params.data.outfitId, userId: request.user.userId },
      select: { items: { orderBy: { sortOrder: 'asc' }, select: { productId: true, variantId: true } } },
    });
    if (!outfit) return reply.status(404).send({ code: 'OUTFIT_NOT_FOUND', message: 'Outfit not found' });
    const productsFound = await app.prisma.commerceProduct.findMany({
      where: {
        id: { in: [...new Set(outfit.items.map((item) => item.productId))] },
        status: 'PUBLISHED',
      },
      select: {
        id: true,
        stock: true,
        preorderEnabled: true,
        preorderLimit: true,
        preorderReserved: true,
        variants: {
          where: { active: true },
          select: { id: true, stock: true },
        },
      },
    });
    const products = new Map(productsFound.map((product) => [product.id, product]));
    const accepted: string[] = [];
    const rejected: Array<{ productId: string; variantId: string | null; code: string }> = [];

    await app.prisma.$transaction(async (tx) => {
      const cart = await tx.commerceCart.upsert({
        where: { userId: request.user.userId },
        create: { userId: request.user.userId },
        update: {},
        select: { id: true },
      });
      await tx.$queryRaw`SELECT "id" FROM "CommerceCart" WHERE "id" = ${cart.id} FOR UPDATE`;
      for (const item of outfit.items) {
        const product = products.get(item.productId);
        if (!product) {
          rejected.push({ ...item, code: 'PRODUCT_NOT_AVAILABLE' });
          continue;
        }
        const variant = item.variantId ? product.variants.find((entry) => entry.id === item.variantId) : undefined;
        if ((item.variantId && !variant) || (!item.variantId && product.variants.length)) {
          rejected.push({ ...item, code: 'VARIANT_NOT_AVAILABLE' });
          continue;
        }
        const key = `${item.productId}:${item.variantId ?? 'none'}`;
        const current = await tx.commerceCartItem.findUnique({
          where: { cartId_itemKey: { cartId: cart.id, itemKey: key } },
          select: { quantity: true },
        });
        const stock = variant?.stock ?? product.stock;
        const preorderAvailable = Math.max(0, product.preorderLimit - product.preorderReserved);
        const nextQuantity = (current?.quantity ?? 0) + 1;
        const availableFromStock = nextQuantity <= stock;
        const availableAsPreorder = product.preorderEnabled && nextQuantity <= preorderAvailable;
        if (!availableFromStock && !availableAsPreorder) {
          rejected.push({ ...item, code: 'INSUFFICIENT_STOCK' });
          continue;
        }
        await tx.commerceCartItem.upsert({
          where: { cartId_itemKey: { cartId: cart.id, itemKey: key } },
          create: { cartId: cart.id, itemKey: key, productId: item.productId, variantId: item.variantId, quantity: 1 },
          update: { quantity: { increment: 1 } },
        });
        accepted.push(item.productId);
      }
    });

    return reply.status(rejected.length ? 207 : 200).send({
      addedProductIds: accepted,
      rejectedItems: rejected,
      message: rejected.length ? 'Some outfit items could not be added; see rejectedItems.' : 'Outfit added to cart.',
    });
  });
};
