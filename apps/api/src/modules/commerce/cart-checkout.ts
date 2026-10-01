import { createHash, randomBytes } from 'node:crypto';
import type { AveronOrderStatus, Prisma, ProductPublicationStatus } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../../lib/authMiddleware';

const quantitySchema = z.number().int().min(1).max(99);
const cartItemSchema = z.object({
  productId: z.string().min(1).max(128),
  variantId: z.string().min(1).max(128).optional(),
  quantity: quantitySchema,
}).strict();
const updateCartItemSchema = z.object({ quantity: quantitySchema }).strict();
const checkoutSchema = z.object({
  contact: z.object({
    name: z.string().trim().min(1).max(100),
    phone: z.string().trim().min(7).max(32).regex(/^[+0-9 ()-]+$/),
  }).strict(),
  deliveryAddress: z.object({
    city: z.string().trim().min(1).max(100),
    address: z.string().trim().min(1).max(500),
    district: z.string().trim().max(100).optional(),
    apartment: z.string().trim().max(100).optional(),
    entrance: z.string().trim().max(50).optional(),
    postalCode: z.string().trim().max(30).optional(),
    deliveryInstructions: z.string().trim().max(500).optional(),
  }).strict(),
}).strict();

type CheckoutInput = z.infer<typeof checkoutSchema>;
type ProductForCart = {
  id: string;
  status: ProductPublicationStatus;
  translations: Prisma.JsonValue;
  salePriceUzs: Prisma.Decimal;
  stock: number;
  images: Array<{ url: string }>;
  variants: Array<{
    id: string;
    productId: string;
    color: string | null;
    size: string | null;
    sku: string;
    salePriceUzs: Prisma.Decimal;
    stock: number;
    active: boolean;
  }>;
};

const productSelect = {
  id: true,
  status: true,
  translations: true,
  salePriceUzs: true,
  stock: true,
  images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } },
  variants: {
    select: { id: true, productId: true, color: true, size: true, sku: true, salePriceUzs: true, stock: true, active: true },
  },
} satisfies Prisma.CommerceProductSelect;

function moneyToCents(value: Prisma.Decimal | number | string): number {
  const amount = Number(value);
  const cents = Math.round(amount * 100);
  if (!Number.isFinite(amount) || !Number.isSafeInteger(cents) || cents < 0) {
    throw new Error('INVALID_PRICE');
  }
  return cents;
}

function centsToMoney(cents: number): string {
  return (cents / 100).toFixed(2);
}

function centsToNumber(cents: number): number {
  return cents / 100;
}

function titleFor(translations: Prisma.JsonValue, fallback: string): string {
  if (!translations || typeof translations !== 'object' || Array.isArray(translations)) return fallback;
  const localized = translations as Record<string, unknown>;
  for (const language of ['ru', 'uz', 'en']) {
    const value = localized[language];
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).title === 'string') {
      return (value as { title: string }).title;
    }
  }
  return fallback;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function checkoutHash(input: CheckoutInput): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

function selectVariant(product: ProductForCart, variantId?: string) {
  if (variantId) {
    const variant = product.variants.find((candidate) => candidate.id === variantId && candidate.active);
    return variant ?? null;
  }
  return product.variants.length === 0 ? null : undefined;
}

function productIsAvailable(product: ProductForCart, variantId?: string): boolean {
  if (product.status !== 'PUBLISHED') return false;
  const variant = selectVariant(product, variantId);
  if (variantId) return Boolean(variant && variant.stock > 0);
  if (variant === undefined) return false;
  return product.stock > 0;
}

function itemTitle(product: ProductForCart, variant?: ProductForCart['variants'][number] | null): string {
  const title = titleFor(product.translations, product.id);
  const options = [variant?.color, variant?.size].filter(Boolean);
  return options.length ? `${title} (${options.join(', ')})` : title;
}

function cartPrice(product: ProductForCart, variantId?: string) {
  const variant = selectVariant(product, variantId);
  if (variant === undefined || (variantId && !variant)) return null;
  return {
    title: itemTitle(product, variant),
    unitPriceCents: moneyToCents(variant?.salePriceUzs ?? product.salePriceUzs),
    stock: variant?.stock ?? product.stock,
  };
}

async function ensureCart(prisma: PrismaClient | Prisma.TransactionClient, userId: string) {
  return prisma.commerceCart.upsert({
    where: { userId },
    create: { userId },
    update: {},
    select: { id: true },
  });
}

async function getCartDto(prisma: PrismaClient | Prisma.TransactionClient, userId: string) {
  const cart = await ensureCart(prisma, userId);
  const stored = await prisma.commerceCart.findUnique({
    where: { id: cart.id },
    include: {
      items: {
        orderBy: { createdAt: 'asc' },
        include: { product: { select: productSelect }, variant: true },
      },
    },
  });
  const items = (stored?.items ?? []).map((item) => {
    const product = item.product as ProductForCart;
    const pricing = product.status === 'PUBLISHED' ? cartPrice(product, item.variantId ?? undefined) : null;
    const available = Boolean(
      pricing
      && productIsAvailable(product, item.variantId ?? undefined)
      && item.quantity <= pricing.stock,
    );
    return {
      id: item.id,
      productId: item.productId,
      variantId: item.variantId,
      title: pricing?.title ?? product.id,
      imageUrl: product.images?.[0]?.url ?? null,
      variant: item.variant ? {
        color: item.variant.color,
        size: item.variant.size,
        sku: item.variant.sku,
      } : null,
      quantity: item.quantity,
      stock: pricing?.stock ?? 0,
      available,
      ...(available ? {} : {
        availabilityCode: product.status !== 'PUBLISHED'
          ? 'PRODUCT_UNAVAILABLE'
          : !pricing
            ? 'VARIANT_UNAVAILABLE'
            : pricing.stock === 0
              ? 'OUT_OF_STOCK'
              : 'QUANTITY_EXCEEDS_STOCK',
      }),
      unitPriceUzs: centsToMoney(pricing?.unitPriceCents ?? moneyToCents(product.salePriceUzs)),
      lineTotalUzs: centsToMoney((pricing?.unitPriceCents ?? moneyToCents(product.salePriceUzs)) * item.quantity),
    };
  });
  const subtotalCents = items.reduce((sum, item) => sum + moneyToCents(item.lineTotalUzs), 0);
  return { items, subtotalUzs: centsToMoney(subtotalCents), currency: 'UZS' as const };
}

function orderSelect() {
  return {
    orderNumber: true,
    status: true,
    currency: true,
    subtotal: true,
    discount: true,
    deliveryCost: true,
    totalRevenue: true,
    createdAt: true,
    items: {
      select: {
        title: true,
        variantSnapshot: true,
        quantity: true,
        unitPrice: true,
        totalPrice: true,
      },
    },
  } satisfies Prisma.CommerceOrderSelect;
}

type SafeOrderSource = Prisma.CommerceOrderGetPayload<{ select: ReturnType<typeof orderSelect> }>;

function safeOrder(order: SafeOrderSource) {
  return {
    orderNumber: order.orderNumber,
    status: order.status as AveronOrderStatus,
    currency: order.currency,
    subtotal: Number(order.subtotal),
    discount: Number(order.discount),
    deliveryCost: Number(order.deliveryCost),
    totalRevenue: Number(order.totalRevenue),
    createdAt: order.createdAt,
    items: (order.items ?? []).map((item) => ({
      title: item.title,
      ...(item.variantSnapshot ? { variantSnapshot: item.variantSnapshot } : {}),
      quantity: item.quantity,
      unitPrice: Number(item.unitPrice),
      totalPrice: Number(item.totalPrice),
    })),
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export const cartCheckoutModule: FastifyPluginAsync = async (app) => {
  app.get('/cart', {
    preHandler: authMiddleware,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    try {
      return await getCartDto(app.prisma, request.user.userId);
    } catch (error) {
      request.log.error({ error }, 'Unable to load cart');
      return reply.status(500).send({ message: 'Unable to load cart' });
    }
  });

  app.post('/cart/items', {
    preHandler: authMiddleware,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const parsed = cartItemSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ message: 'Invalid cart item' });
    const { productId, variantId, quantity } = parsed.data;
    try {
      const result = await app.prisma.$transaction(async (tx) => {
        const cart = await ensureCart(tx, request.user.userId);
        const product = await tx.commerceProduct.findUnique({ where: { id: productId }, select: productSelect }) as ProductForCart | null;
        if (!product || product.status !== 'PUBLISHED') return { error: 'PRODUCT_UNAVAILABLE' as const };
        const variant = selectVariant(product, variantId);
        if ((variantId && !variant) || (!variantId && variant === undefined)) return { error: 'VARIANT_REQUIRED' as const };
        const stock = variant?.stock ?? product.stock;
        const unitPriceCents = moneyToCents(variant?.salePriceUzs ?? product.salePriceUzs);
        const itemKey = `${productId}:${variantId ?? 'none'}`;
        const existing = await tx.commerceCartItem.findUnique({
          where: { cartId_itemKey: { cartId: cart.id, itemKey } },
          select: { quantity: true },
        });
        if ((existing?.quantity ?? 0) + quantity > 99) return { error: 'QUANTITY_LIMIT' as const };
        if ((existing?.quantity ?? 0) + quantity > stock) return { error: 'INSUFFICIENT_STOCK' as const };
        await tx.commerceCartItem.upsert({
          where: { cartId_itemKey: { cartId: cart.id, itemKey } },
          create: { cartId: cart.id, itemKey, productId, variantId, quantity },
          update: { quantity: { increment: quantity } },
        });
        return { ok: true, unitPriceCents };
      });
      if ('error' in result) {
        const conflict = result.error === 'INSUFFICIENT_STOCK' || result.error === 'QUANTITY_LIMIT';
        return reply.status(conflict ? 409 : 400).send({ message: result.error });
      }
      return reply.status(201).send(await getCartDto(app.prisma, request.user.userId));
    } catch (error) {
      if (errorCode(error) === 'P2004') return reply.status(409).send({ message: 'Cart quantity or stock limit exceeded' });
      request.log.error({ error }, 'Unable to update cart');
      return reply.status(500).send({ message: 'Unable to update cart' });
    }
  });

  app.patch<{ Params: { itemId: string } }>('/cart/items/:itemId', {
    preHandler: authMiddleware,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const parsed = updateCartItemSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ message: 'Invalid quantity' });
    try {
      const cart = await ensureCart(app.prisma, request.user.userId);
      const item = await app.prisma.commerceCartItem.findFirst({
        where: { id: request.params.itemId, cartId: cart.id },
        include: { product: { select: productSelect }, variant: true },
      });
      if (!item) return reply.status(404).send({ message: 'Cart item not found' });
      const product = item.product as ProductForCart;
      if (product.status !== 'PUBLISHED') return reply.status(409).send({ message: 'Product is unavailable' });
      const pricing = cartPrice(product, item.variantId ?? undefined);
      if (!pricing) return reply.status(409).send({ message: 'Product variant is unavailable' });
      if (parsed.data.quantity > pricing.stock) return reply.status(409).send({ message: 'Insufficient stock' });
      await app.prisma.commerceCartItem.updateMany({
        where: { id: item.id, cartId: cart.id },
        data: { quantity: parsed.data.quantity },
      });
      return await getCartDto(app.prisma, request.user.userId);
    } catch (error) {
      request.log.error({ error }, 'Unable to update cart item');
      return reply.status(500).send({ message: 'Unable to update cart item' });
    }
  });

  app.delete<{ Params: { itemId: string } }>('/cart/items/:itemId', {
    preHandler: authMiddleware,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    try {
      const cart = await ensureCart(app.prisma, request.user.userId);
      const result = await app.prisma.commerceCartItem.deleteMany({
        where: { id: request.params.itemId, cartId: cart.id },
      });
      if (result.count === 0) return reply.status(404).send({ message: 'Cart item not found' });
      return await getCartDto(app.prisma, request.user.userId);
    } catch (error) {
      request.log.error({ error }, 'Unable to remove cart item');
      return reply.status(500).send({ message: 'Unable to remove cart item' });
    }
  });

  app.delete('/cart', {
    preHandler: authMiddleware,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    try {
      const cart = await ensureCart(app.prisma, request.user.userId);
      await app.prisma.commerceCartItem.deleteMany({ where: { cartId: cart.id } });
      return { items: [], subtotalUzs: '0.00', currency: 'UZS' as const };
    } catch (error) {
      request.log.error({ error }, 'Unable to clear cart');
      return reply.status(500).send({ message: 'Unable to clear cart' });
    }
  });

  app.post('/checkout', {
    preHandler: authMiddleware,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const parsed = checkoutSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ message: 'Invalid checkout details' });
    const rawKey = request.headers['idempotency-key'];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (!key || key.length > 128 || !/^[\x21-\x7e]+$/.test(key)) {
      return reply.status(400).send({ message: 'A valid Idempotency-Key header is required' });
    }
    const input = parsed.data;
    const requestHash = checkoutHash(input);
    const userId = request.user.userId;

    try {
      const existing = await app.prisma.commerceCheckoutIdempotency.findUnique({
        where: { userId_key: { userId, key } },
        select: { requestHash: true, orderId: true },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) return reply.status(409).send({ message: 'Idempotency key was already used with different details' });
        const order = await app.prisma.commerceOrder.findUnique({
          where: { id: existing.orderId },
          select: orderSelect(),
        });
        if (!order) return reply.status(409).send({ message: 'Idempotent order is no longer available' });
        return reply.status(200).send(safeOrder(order));
      }

      const result = await app.prisma.$transaction(async (tx) => {
        const race = await tx.commerceCheckoutIdempotency.findUnique({
          where: { userId_key: { userId, key } },
          select: { requestHash: true, orderId: true },
        });
        if (race) return { orderId: race.orderId, requestHash: race.requestHash, replayed: true };

        // Serialize different idempotency keys for the same cart so one cart cannot be checked out twice.
        await tx.$queryRaw`SELECT "id" FROM "CommerceCart" WHERE "userId" = ${userId} FOR UPDATE`;
        const cart = await tx.commerceCart.findUnique({
          where: { userId },
          include: {
            items: {
              orderBy: { createdAt: 'asc' },
              include: { product: { select: productSelect }, variant: true },
            },
          },
        });
        if (!cart || cart.items.length === 0) return { error: 'CART_EMPTY' as const };

        let subtotalCents = 0;
        const snapshots: Array<{
          productId: string;
          variantId: string | null;
          title: string;
          variantSnapshot?: Prisma.InputJsonObject;
          quantity: number;
          unitPrice: number;
          totalPrice: number;
        }> = [];

        for (const cartItem of cart.items) {
          const product = await tx.commerceProduct.findUnique({
            where: { id: cartItem.productId },
            select: productSelect,
          }) as ProductForCart | null;
          if (!product || product.status !== 'PUBLISHED') return { error: 'PRODUCT_UNAVAILABLE' as const };
          const variant = selectVariant(product, cartItem.variantId ?? undefined);
          if ((cartItem.variantId && !variant) || (!cartItem.variantId && variant === undefined)) {
            return { error: 'VARIANT_UNAVAILABLE' as const };
          }
          const availableStock = variant?.stock ?? product.stock;
          if (cartItem.quantity < 1 || cartItem.quantity > 99 || cartItem.quantity > availableStock) {
            return { error: 'INSUFFICIENT_STOCK' as const };
          }
          const unitPriceCents = moneyToCents(variant?.salePriceUzs ?? product.salePriceUzs);
          const lineTotalCents = unitPriceCents * cartItem.quantity;
          if (!Number.isSafeInteger(lineTotalCents)) return { error: 'INVALID_PRICE' as const };
          subtotalCents += lineTotalCents;
          if (!Number.isSafeInteger(subtotalCents)) return { error: 'INVALID_PRICE' as const };
          snapshots.push({
            productId: product.id,
            variantId: variant?.id ?? null,
            title: itemTitle(product, variant),
            ...(variant ? {
              variantSnapshot: {
                color: variant.color,
                size: variant.size,
                sku: variant.sku,
              },
            } : {}),
            quantity: cartItem.quantity,
            unitPrice: centsToNumber(unitPriceCents),
            totalPrice: centsToNumber(lineTotalCents),
          });
          const claim = variant
            ? await tx.commerceProductVariant.updateMany({
              where: { id: variant.id, productId: product.id, active: true, stock: { gte: cartItem.quantity } },
              data: { stock: { decrement: cartItem.quantity } },
            })
            : await tx.commerceProduct.updateMany({
              where: { id: product.id, status: 'PUBLISHED', stock: { gte: cartItem.quantity } },
              data: { stock: { decrement: cartItem.quantity } },
            });
          if (claim.count !== 1) return { error: 'INSUFFICIENT_STOCK' as const };
        }

        const orderNumber = `AV-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`;
        const order = await tx.commerceOrder.create({
          data: {
            orderNumber,
            userId,
            status: 'CREATED',
            currency: 'UZS',
            subtotal: centsToNumber(subtotalCents),
            discount: 0,
            deliveryCost: 0,
            totalRevenue: centsToNumber(subtotalCents),
            contact: input.contact as Prisma.InputJsonObject,
            deliveryAddress: input.deliveryAddress as Prisma.InputJsonObject,
            items: { create: snapshots },
            statusHistory: { create: { status: 'CREATED', actorId: userId } },
          },
          select: { id: true },
        });
        await tx.commerceCartItem.deleteMany({ where: { cartId: cart.id } });
        await tx.commerceCheckoutIdempotency.create({
          data: { userId, key, requestHash, orderId: order.id },
        });
        return { orderId: order.id, requestHash, replayed: false };
      });

      if ('error' in result) {
        const concurrent = await app.prisma.commerceCheckoutIdempotency.findUnique({
          where: { userId_key: { userId, key } },
          select: { requestHash: true, orderId: true },
        });
        if (concurrent) {
          if (concurrent.requestHash !== requestHash) {
            return reply.status(409).send({ message: 'Idempotency key was already used with different details' });
          }
          const replayedOrder = await app.prisma.commerceOrder.findUnique({
            where: { id: concurrent.orderId },
            select: orderSelect(),
          });
          if (replayedOrder) return reply.status(200).send(safeOrder(replayedOrder));
        }
        const status = result.error === 'CART_EMPTY' ? 400 : 409;
        return reply.status(status).send({ message: result.error });
      }
      if (result.requestHash !== requestHash) {
        return reply.status(409).send({ message: 'Idempotency key was already used with different details' });
      }
      const order = await app.prisma.commerceOrder.findUnique({
        where: { id: result.orderId },
        select: orderSelect(),
      });
      if (!order) return reply.status(500).send({ message: 'Unable to load created order' });
      return reply.status(result.replayed ? 200 : 201).send(safeOrder(order));
    } catch (error) {
      if (errorCode(error) === 'P2002') {
        try {
          const concurrent = await app.prisma.commerceCheckoutIdempotency.findUnique({
            where: { userId_key: { userId, key } },
            select: { requestHash: true, orderId: true },
          });
          if (concurrent) {
            if (concurrent.requestHash !== requestHash) {
              return reply.status(409).send({ message: 'Idempotency key was already used with different details' });
            }
            const order = await app.prisma.commerceOrder.findUnique({
              where: { id: concurrent.orderId },
              select: orderSelect(),
            });
            if (order) return reply.status(200).send(safeOrder(order));
          }
        } catch (lookupError) {
          request.log.error({ error: lookupError }, 'Unable to resolve concurrent checkout');
        }
        return reply.status(409).send({ message: 'Checkout conflict; retry with the same idempotency key' });
      }
      request.log.error({ error }, 'Checkout failed');
      return reply.status(500).send({ message: 'Unable to complete checkout' });
    }
  });
};
