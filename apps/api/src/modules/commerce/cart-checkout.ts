import { createHash, randomBytes } from 'node:crypto';
import type { AveronOrderStatus, Prisma, ProductPublicationStatus } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../../lib/authMiddleware';
import { normalizePromoCode, promoFailureCode } from './commerce-promos';

const quantitySchema = z.number().int().min(1).max(99);
const cartItemSchema = z.object({
  productId: z.string().min(1).max(128),
  variantId: z.string().min(1).max(128).optional(),
  quantity: quantitySchema,
}).strict();
const updateCartItemSchema = z.object({ quantity: quantitySchema }).strict();
const checkoutSchema = z.object({
  deliveryMethod: z.enum(['COURIER', 'PICKUP']).default('COURIER'),
  promoCode: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/).optional(),
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
    floor: z.string().trim().max(50).optional(),
    postalCode: z.string().trim().max(30).optional(),
    deliveryInstructions: z.string().trim().max(500).optional(),
    comment: z.string().trim().max(500).optional(),
  }).strict(),
}).strict();

type CheckoutInput = z.infer<typeof checkoutSchema>;
type ProductForCart = {
  id: string;
  status: ProductPublicationStatus;
  translations: Prisma.JsonValue;
  salePriceUzs: Prisma.Decimal;
  stock: number;
  preorderEnabled: boolean;
  preorderLimit: number;
  preorderReserved: number;
  preorderEstimatedAt: Date | null;
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

class CheckoutFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const productSelect = {
  id: true,
  status: true,
  translations: true,
  salePriceUzs: true,
  stock: true,
  preorderEnabled: true,
  preorderLimit: true,
  preorderReserved: true,
  preorderEstimatedAt: true,
  images: { orderBy: { sortOrder: 'asc' }, take: 1, select: { url: true } },
  variants: {
    select: { id: true, productId: true, color: true, size: true, sku: true, salePriceUzs: true, stock: true, active: true },
  },
} satisfies Prisma.CommerceProductSelect;

function moneyToCents(value: Prisma.Decimal | number | string): number {
  const amount = Number(value);
  const cents = Math.round(amount * 100);
  if (!Number.isFinite(amount) || !Number.isSafeInteger(cents) || cents < 0) {
    throw new CheckoutFailure('INVALID_PRICE');
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
  const preorderAvailable = product.preorderEnabled
    ? Math.max(0, product.preorderLimit - product.preorderReserved)
    : 0;
  if (variantId) return Boolean(variant && (variant.stock > 0 || preorderAvailable > 0));
  if (variant === undefined) return false;
  return product.stock > 0 || preorderAvailable > 0;
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
    preorderAvailable: product.preorderEnabled
      ? Math.max(0, product.preorderLimit - product.preorderReserved)
      : 0,
    preorderEnabled: product.preorderEnabled,
    preorderEstimatedAt: product.preorderEstimatedAt,
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

async function lockCart(tx: Prisma.TransactionClient, userId: string) {
  const cart = await ensureCart(tx, userId);
  await tx.$queryRaw`SELECT "id" FROM "CommerceCart" WHERE "id" = ${cart.id} FOR UPDATE`;
  return cart;
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
    const fulfillsFromStock = Boolean(pricing && item.quantity <= pricing.stock);
    const fulfillsAsPreorder = Boolean(pricing
      && pricing.preorderEnabled
      && item.quantity <= pricing.preorderAvailable);
    const available = Boolean(pricing
      && productIsAvailable(product, item.variantId ?? undefined)
      && (fulfillsFromStock || fulfillsAsPreorder));
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
      preorderEligible: Boolean(pricing?.preorderEnabled && pricing.preorderAvailable > 0),
      preorderAvailable: pricing?.preorderAvailable ?? 0,
      estimatedAvailableAt: pricing?.preorderEstimatedAt ?? null,
      fulfillmentType: fulfillsFromStock ? 'STOCK' as const : fulfillsAsPreorder ? 'PREORDER' as const : null,
      available,
      ...(available ? {} : {
        availabilityCode: product.status !== 'PUBLISHED'
          ? 'PRODUCT_UNAVAILABLE'
          : !pricing
            ? 'VARIANT_UNAVAILABLE'
            : pricing.stock === 0
              ? pricing.preorderEnabled && item.quantity > pricing.preorderAvailable
                ? 'PREORDER_LIMIT_REACHED'
                : 'OUT_OF_STOCK'
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
    delivery: {
      select: {
        method: true,
        recipient: true,
        phone: true,
        destination: true,
        status: true,
        trackingNumber: true,
        provider: true,
        estimatedDeliveryAt: true,
        shippedAt: true,
        deliveredAt: true,
        history: {
          orderBy: { createdAt: 'asc' },
          select: { status: true, createdAt: true },
        },
      },
    },
    items: {
      select: {
        title: true,
        variantSnapshot: true,
        quantity: true,
        unitPrice: true,
        totalPrice: true,
        isPreorder: true,
        preorderEstimatedAt: true,
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
    delivery: order.delivery ? {
      method: order.delivery.method,
      recipient: order.delivery.recipient,
      phone: order.delivery.phone,
      destination: order.delivery.destination,
      status: order.delivery.status,
      trackingNumber: order.delivery.trackingNumber,
      provider: order.delivery.provider,
      estimatedDeliveryAt: order.delivery.estimatedDeliveryAt,
      shippedAt: order.delivery.shippedAt,
      deliveredAt: order.delivery.deliveredAt,
      history: order.delivery.history,
    } : null,
    items: (order.items ?? []).map((item) => ({
      title: item.title,
      ...(item.variantSnapshot ? { variantSnapshot: item.variantSnapshot } : {}),
      quantity: item.quantity,
      unitPrice: Number(item.unitPrice),
      totalPrice: Number(item.totalPrice),
      isPreorder: item.isPreorder,
      ...(item.isPreorder ? { estimatedAvailableAt: item.preorderEstimatedAt } : {}),
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
      return reply.status(500).send({ code: 'CART_LOAD_FAILED', message: 'Unable to load cart' });
    }
  });

  app.post('/cart/items', {
    preHandler: authMiddleware,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const parsed = cartItemSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_CART_ITEM', message: 'Invalid cart item' });
    const { productId, variantId, quantity } = parsed.data;
    try {
      const result = await app.prisma.$transaction(async (tx) => {
        const cart = await lockCart(tx, request.user.userId);
        const product = await tx.commerceProduct.findUnique({ where: { id: productId }, select: productSelect }) as ProductForCart | null;
        if (!product || product.status !== 'PUBLISHED') return { error: 'PRODUCT_NOT_AVAILABLE' as const };
        const variant = selectVariant(product, variantId);
        if ((variantId && !variant) || (!variantId && variant === undefined)) return { error: 'VARIANT_NOT_AVAILABLE' as const };
        const stock = variant?.stock ?? product.stock;
        const unitPriceCents = moneyToCents(variant?.salePriceUzs ?? product.salePriceUzs);
        const itemKey = `${productId}:${variantId ?? 'none'}`;
        const existing = await tx.commerceCartItem.findUnique({
          where: { cartId_itemKey: { cartId: cart.id, itemKey } },
          select: { quantity: true },
        });
        if ((existing?.quantity ?? 0) + quantity > 99) return { error: 'QUANTITY_LIMIT' as const };
        const preorderAvailable = product.preorderEnabled
          ? Math.max(0, product.preorderLimit - product.preorderReserved)
          : 0;
        const nextQuantity = (existing?.quantity ?? 0) + quantity;
        if (nextQuantity > stock && nextQuantity > preorderAvailable) {
          return { error: 'INSUFFICIENT_STOCK' as const };
        }
        await tx.commerceCartItem.upsert({
          where: { cartId_itemKey: { cartId: cart.id, itemKey } },
          create: { cartId: cart.id, itemKey, productId, variantId, quantity },
          update: { quantity: { increment: quantity } },
        });
        return { ok: true, unitPriceCents };
      });
      if ('error' in result) {
        const conflict = result.error === 'INSUFFICIENT_STOCK' || result.error === 'QUANTITY_LIMIT';
        return reply.status(conflict ? 409 : 400).send({ code: result.error, message: result.error });
      }
      return reply.status(201).send(await getCartDto(app.prisma, request.user.userId));
    } catch (error) {
      if (errorCode(error) === 'P2004') return reply.status(409).send({ code: 'INVALID_QUANTITY', message: 'Cart quantity or stock limit exceeded' });
      request.log.error({ error }, 'Unable to update cart');
      return reply.status(500).send({ code: 'CART_UPDATE_FAILED', message: 'Unable to update cart' });
    }
  });

  app.patch<{ Params: { itemId: string } }>('/cart/items/:itemId', {
    preHandler: authMiddleware,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const parsed = updateCartItemSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_QUANTITY', message: 'Invalid quantity' });
    try {
      const result = await app.prisma.$transaction(async (tx) => {
        const cart = await lockCart(tx, request.user.userId);
        const item = await tx.commerceCartItem.findFirst({
          where: { id: request.params.itemId, cartId: cart.id },
          include: { product: { select: productSelect }, variant: true },
        });
        if (!item) return { error: 'CART_ITEM_NOT_FOUND' as const };
        const product = item.product as ProductForCart;
        if (product.status !== 'PUBLISHED') return { error: 'PRODUCT_NOT_AVAILABLE' as const };
        const pricing = cartPrice(product, item.variantId ?? undefined);
        if (!pricing) return { error: 'VARIANT_NOT_AVAILABLE' as const };
        if (parsed.data.quantity > pricing.stock && parsed.data.quantity > pricing.preorderAvailable) {
          return { error: 'INSUFFICIENT_STOCK' as const };
        }
        await tx.commerceCartItem.updateMany({
          where: { id: item.id, cartId: cart.id },
          data: { quantity: parsed.data.quantity },
        });
        return { ok: true as const };
      });
      if ('error' in result) {
        const status = result.error === 'CART_ITEM_NOT_FOUND' ? 404 : result.error === 'PRODUCT_NOT_AVAILABLE' ? 409 : 409;
        return reply.status(status).send({ code: result.error, message: result.error });
      }
      return await getCartDto(app.prisma, request.user.userId);
    } catch (error) {
      request.log.error({ error }, 'Unable to update cart item');
      return reply.status(500).send({ code: 'CART_UPDATE_FAILED', message: 'Unable to update cart item' });
    }
  });

  app.delete<{ Params: { itemId: string } }>('/cart/items/:itemId', {
    preHandler: authMiddleware,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    try {
      const result = await app.prisma.$transaction(async (tx) => {
        const cart = await lockCart(tx, request.user.userId);
        return tx.commerceCartItem.deleteMany({
          where: { id: request.params.itemId, cartId: cart.id },
        });
      });
      if (result.count === 0) return reply.status(404).send({ code: 'CART_ITEM_NOT_FOUND', message: 'Cart item not found' });
      return await getCartDto(app.prisma, request.user.userId);
    } catch (error) {
      request.log.error({ error }, 'Unable to remove cart item');
      return reply.status(500).send({ code: 'CART_UPDATE_FAILED', message: 'Unable to remove cart item' });
    }
  });

  app.delete('/cart', {
    preHandler: authMiddleware,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    try {
      await app.prisma.$transaction(async (tx) => {
        const cart = await lockCart(tx, request.user.userId);
        await tx.commerceCartItem.deleteMany({ where: { cartId: cart.id } });
      });
      return { items: [], subtotalUzs: '0.00', currency: 'UZS' as const };
    } catch (error) {
      request.log.error({ error }, 'Unable to clear cart');
      return reply.status(500).send({ code: 'CART_UPDATE_FAILED', message: 'Unable to clear cart' });
    }
  });

  app.post('/checkout', {
    preHandler: authMiddleware,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const parsed = checkoutSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_CHECKOUT_DETAILS', message: 'Invalid checkout details' });
    const rawKey = request.headers['idempotency-key'];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (!key || key.length > 128 || !/^[\x21-\x7e]+$/.test(key)) {
      return reply.status(400).send({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'A valid Idempotency-Key header is required' });
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
        if (existing.requestHash !== requestHash) return reply.status(409).send({ code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency key was already used with different details' });
        const order = await app.prisma.commerceOrder.findUnique({
          where: { id: existing.orderId },
          select: orderSelect(),
        });
        if (!order) return reply.status(409).send({ code: 'CHECKOUT_CONFLICT', message: 'Idempotent order is no longer available' });
        return reply.status(200).send(safeOrder(order));
      }

      const result = await app.prisma.$transaction(async (tx) => {
        // Serialize different idempotency keys for the same cart so one cart cannot be checked out twice.
        await tx.$queryRaw`SELECT "id" FROM "CommerceCart" WHERE "userId" = ${userId} FOR UPDATE`;
        // Recheck after acquiring the cart lock: a concurrent request with the same key may
        // have committed while this transaction was waiting for the lock.
        const race = await tx.commerceCheckoutIdempotency.findUnique({
          where: { userId_key: { userId, key } },
          select: { requestHash: true, orderId: true },
        });
        if (race) return { orderId: race.orderId, requestHash: race.requestHash, replayed: true };

        const cart = await tx.commerceCart.findUnique({
          where: { userId },
          include: {
            items: {
              orderBy: { createdAt: 'asc' },
              include: { product: { select: productSelect }, variant: true },
            },
          },
        });
        if (!cart || cart.items.length === 0) throw new CheckoutFailure('CART_EMPTY');

        let subtotalCents = 0;
        const snapshots: Array<{
          productId: string;
          variantId: string | null;
          title: string;
          variantSnapshot?: Prisma.InputJsonObject;
          quantity: number;
          unitPrice: number;
          totalPrice: number;
          isPreorder: boolean;
          preorderEstimatedAt: Date | null;
        }> = [];

        for (const cartItem of cart.items) {
          const product = await tx.commerceProduct.findUnique({
            where: { id: cartItem.productId },
            select: productSelect,
          }) as ProductForCart | null;
          if (!product || product.status !== 'PUBLISHED') throw new CheckoutFailure('PRODUCT_NOT_AVAILABLE');
          const variant = selectVariant(product, cartItem.variantId ?? undefined);
          if ((cartItem.variantId && !variant) || (!cartItem.variantId && variant === undefined)) {
            throw new CheckoutFailure('VARIANT_NOT_AVAILABLE');
          }
          if (cartItem.quantity < 1 || cartItem.quantity > 99) {
            throw new CheckoutFailure('INSUFFICIENT_STOCK');
          }
          const unitPriceCents = moneyToCents(variant?.salePriceUzs ?? product.salePriceUzs);
          const lineTotalCents = unitPriceCents * cartItem.quantity;
          if (!Number.isSafeInteger(lineTotalCents)) throw new CheckoutFailure('INVALID_PRICE');
          subtotalCents += lineTotalCents;
          if (!Number.isSafeInteger(subtotalCents)) throw new CheckoutFailure('INVALID_PRICE');
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
            isPreorder: false,
            preorderEstimatedAt: null,
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
          if (claim.count !== 1) {
            const preorderAvailable = product.preorderEnabled
              ? Math.max(0, product.preorderLimit - product.preorderReserved)
              : 0;
            if (!product.preorderEnabled || cartItem.quantity > preorderAvailable) {
              throw new CheckoutFailure('INSUFFICIENT_STOCK');
            }
            const preorderClaim = await tx.commerceProduct.updateMany({
              where: {
                id: product.id,
                status: 'PUBLISHED',
                preorderEnabled: true,
                preorderReserved: { equals: product.preorderReserved },
                preorderLimit: { gte: product.preorderReserved + cartItem.quantity },
              },
              data: { preorderReserved: { increment: cartItem.quantity } },
            });
            if (preorderClaim.count !== 1) throw new CheckoutFailure('INSUFFICIENT_STOCK');
            snapshots[snapshots.length - 1].isPreorder = true;
            snapshots[snapshots.length - 1].preorderEstimatedAt = product.preorderEstimatedAt;
          }
        }

        let discountCents = 0;
        let promoSnapshot: { id: string; discountPercent: number } | null = null;
        if (input.promoCode) {
          const normalizedCode = normalizePromoCode(input.promoCode);
          const promo = await tx.commercePromoCode.findUnique({
            where: { normalizedCode },
          });
          if (!promo) throw new CheckoutFailure('PROMO_NOT_FOUND');
          const promoError = promoFailureCode(promo);
          if (promoError) throw new CheckoutFailure(promoError);
          const existingUsage = await tx.commercePromoCodeUsage.findUnique({
            where: { promoCodeId_userId: { promoCodeId: promo.id, userId } },
            select: { id: true },
          });
          if (existingUsage) throw new CheckoutFailure('PROMO_ALREADY_USED');

          const claimed = await tx.$queryRaw<Array<{ id: string }>>`
            UPDATE "CommercePromoCode"
            SET "usedActivations" = "usedActivations" + 1,
                "updatedAt" = NOW()
            WHERE "id" = ${promo.id}
              AND "isActive" = TRUE
              AND ("startsAt" IS NULL OR "startsAt" <= NOW())
              AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
              AND ("maxActivations" IS NULL OR "usedActivations" < "maxActivations")
            RETURNING "id"
          `;
          if (claimed.length !== 1) throw new CheckoutFailure('PROMO_LIMIT_REACHED');
          promoSnapshot = { id: promo.id, discountPercent: promo.discountPercent };
          discountCents = Math.floor((subtotalCents * promo.discountPercent) / 100);
        }
        const finalTotalCents = subtotalCents - discountCents;

        const orderNumber = `AV-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`;
        const order = await tx.commerceOrder.create({
          data: {
            orderNumber,
            userId,
            status: 'CREATED',
            inventoryCommitted: true,
            currency: 'UZS',
            subtotal: centsToNumber(subtotalCents),
            discount: centsToNumber(discountCents),
            deliveryCost: 0,
            totalRevenue: centsToNumber(finalTotalCents),
            contact: input.contact as Prisma.InputJsonObject,
            deliveryAddress: input.deliveryAddress as Prisma.InputJsonObject,
            items: { create: snapshots },
            statusHistory: { create: { status: 'CREATED', actorId: userId } },
            delivery: {
              create: {
                method: input.deliveryMethod,
                recipient: input.contact.name,
                phone: input.contact.phone,
                destination: input.deliveryAddress as Prisma.InputJsonObject,
                status: 'PENDING',
                history: { create: { status: 'PENDING', changedBy: userId } },
              },
            },
          },
          select: { id: true },
        });
        if (promoSnapshot) {
          await tx.commercePromoCodeUsage.create({
            data: {
              promoCodeId: promoSnapshot.id,
              userId,
              orderId: order.id,
              discountPercentSnapshot: promoSnapshot.discountPercent,
              subtotal: centsToNumber(subtotalCents),
              discountAmount: centsToNumber(discountCents),
              finalTotal: centsToNumber(finalTotalCents),
            },
          });
        }
        await tx.commerceCartItem.deleteMany({ where: { cartId: cart.id } });
        await tx.commerceCheckoutIdempotency.create({
          data: { userId, key, requestHash, orderId: order.id },
        });
        return { orderId: order.id, requestHash, replayed: false };
      });

      if (result.requestHash !== requestHash) {
        return reply.status(409).send({ code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency key was already used with different details' });
      }
      const order = await app.prisma.commerceOrder.findUnique({
        where: { id: result.orderId },
        select: orderSelect(),
      });
      if (!order) return reply.status(500).send({ code: 'ORDER_LOAD_FAILED', message: 'Unable to load created order' });
      return reply.status(result.replayed ? 200 : 201).send(safeOrder(order));
    } catch (error) {
      if (error instanceof CheckoutFailure) {
        const status = error.code === 'CART_EMPTY' ? 400 : error.code === 'INVALID_PRICE' ? 409 :
          error.code.startsWith('PROMO_') ? 400 : 409;
        return reply.status(status).send({ code: error.code, message: error.code });
      }
      if (errorCode(error) === 'P2002') {
        const target = typeof error === 'object' && error !== null && 'meta' in error
          ? (error as { meta?: { target?: unknown } }).meta?.target
          : undefined;
        if (Array.isArray(target) && target.some((field) => String(field).includes('promoCodeId'))) {
          return reply.status(409).send({ code: 'PROMO_ALREADY_USED', message: 'PROMO_ALREADY_USED' });
        }
        try {
          const concurrent = await app.prisma.commerceCheckoutIdempotency.findUnique({
            where: { userId_key: { userId, key } },
            select: { requestHash: true, orderId: true },
          });
          if (concurrent) {
            if (concurrent.requestHash !== requestHash) {
              return reply.status(409).send({ code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency key was already used with different details' });
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
        return reply.status(409).send({ code: 'CHECKOUT_CONFLICT', message: 'Checkout conflict; retry with the same idempotency key' });
      }
      request.log.error({ error }, 'Checkout failed');
      return reply.status(500).send({ code: 'CHECKOUT_FAILED', message: 'Unable to complete checkout' });
    }
  });
};
