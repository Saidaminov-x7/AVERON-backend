/* eslint-disable @typescript-eslint/no-explicit-any */

import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cartCheckoutModule } from '../cart-checkout';
import { commerceOrdersModule } from '../orders';

const USER_A = '00000000-0000-4000-8000-000000000001';
const USER_B = '00000000-0000-4000-8000-000000000002';
const ADMIN = '00000000-0000-4000-8000-000000000003';
const PRODUCT = '00000000-0000-4000-8000-000000000004';
const SECOND_PRODUCT = '00000000-0000-4000-8000-000000000008';
const CART = '00000000-0000-4000-8000-000000000005';
const CART_B = '00000000-0000-4000-8000-000000000009';
const ORDER_ID = '00000000-0000-4000-8000-000000000006';
const VARIANT = '00000000-0000-4000-8000-000000000007';
const JWT_SECRET = 'checkout-orders-test-secret-that-is-at-least-32-characters';

function makeProduct({
  id = PRODUCT,
  status = 'PUBLISHED',
  stock = 5,
  price = '12500.00',
  variants = [],
}: {
  id?: string;
  status?: string;
  stock?: number;
  price?: string;
  variants?: Array<Record<string, unknown>>;
} = {}) {
  return {
    id,
    status,
    stock,
    salePriceUzs: price,
    translations: { ru: { title: 'Куртка' }, en: { title: 'Jacket' } },
    images: [{ url: 'https://cdn.example/jacket.jpg' }],
    variants,
  };
}

function createTestApp(options: {
  products?: Record<string, any>;
  cartItems?: Array<Record<string, any>>;
  initialOrders?: Array<Record<string, any>>;
} = {}) {
  const products = new Map<string, any>(Object.entries(options.products ?? { [PRODUCT]: makeProduct() }));
  const carts = new Map<string, { id: string; userId: string }>();
  const cartItems = options.cartItems ?? [];
  if (cartItems.length > 0) carts.set(USER_A, { id: CART, userId: USER_A });
  if (cartItems.some((item) => item.cartId === CART_B)) carts.set(USER_B, { id: CART_B, userId: USER_B });
  const idempotency = new Map<string, Record<string, any>>();
  const orders = options.initialOrders ?? [];
  const statusHistory: Array<Record<string, unknown>> = [];
  let nextId = 20;
  const id = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;

  const commerceCart = {
    upsert: vi.fn(async ({ where, create }: any) => {
      const existing = carts.get(where.userId);
      if (existing) return existing;
      const cart = { id: create.userId === USER_A ? CART : CART_B, userId: create.userId };
      carts.set(create.userId, cart);
      return cart;
    }),
    findUnique: vi.fn(async ({ where }: any) => {
      const cart = where.userId ? carts.get(where.userId) : [...carts.values()].find((value) => value.id === where.id);
      if (!cart) return null;
      return { ...cart, items: cartItems.filter((item) => item.cartId === cart.id).map((item) => ({
        ...item,
        product: products.get(item.productId),
        variant: item.variantId ? products.get(item.productId)?.variants?.find((variant: any) => variant.id === item.variantId) ?? null : null,
      })) };
    }),
  };
  const commerceCartItem = {
    findUnique: vi.fn(async ({ where }: any) =>
      cartItems.find((item) => item.cartId === where.cartId_itemKey.cartId && item.itemKey === where.cartId_itemKey.itemKey) ?? null),
    findFirst: vi.fn(async ({ where }: any) => cartItems.find((item) => item.id === where.id && item.cartId === where.cartId) ?? null),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      let item = cartItems.find((candidate) =>
        candidate.cartId === where.cartId_itemKey.cartId && candidate.itemKey === where.cartId_itemKey.itemKey);
      if (item) item.quantity += update.quantity.increment;
      else {
        const created = { id: id(), ...create };
        cartItems.push(created);
        item = created;
      }
      return item;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const item = cartItems.find((candidate) => candidate.id === where.id && candidate.cartId === where.cartId);
      if (!item) return { count: 0 };
      Object.assign(item, data);
      return { count: 1 };
    }),
    deleteMany: vi.fn(async ({ where }: any) => {
      const before = cartItems.length;
      for (let index = cartItems.length - 1; index >= 0; index -= 1) {
        if (where.cartId === cartItems[index].cartId && (!where.id || where.id === cartItems[index].id)) cartItems.splice(index, 1);
      }
      return { count: before - cartItems.length };
    }),
  };
  const commerceProduct = {
    findUnique: vi.fn(async ({ where }: any) => products.get(where.id) ?? null),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const product = products.get(where.id);
      if (!product) return { count: 0 };
      if (data.stock.increment !== undefined) {
        product.stock += data.stock.increment;
        return { count: 1 };
      }
      if (product.status !== where.status || product.stock < where.stock.gte) return { count: 0 };
      product.stock -= data.stock.decrement;
      return { count: 1 };
    }),
  };
  const commerceProductVariant = {
    updateMany: vi.fn(async ({ where, data }: any) => {
      const product = products.get(where.productId);
      const variant = product?.variants?.find((candidate: any) =>
        candidate.id === where.id && candidate.productId === where.productId
        && (where.active === undefined || candidate.active));
      if (!variant) return { count: 0 };
      if (data.stock.increment !== undefined) {
        variant.stock += data.stock.increment;
        return { count: 1 };
      }
      if (variant.stock < where.stock.gte) return { count: 0 };
      variant.stock -= data.stock.decrement;
      return { count: 1 };
    }),
  };
  const commerceCheckoutIdempotency = {
    findUnique: vi.fn(async ({ where }: any) => idempotency.get(`${where.userId_key.userId}:${where.userId_key.key}`) ?? null),
    create: vi.fn(async ({ data }: any) => {
      const row = { id: id(), ...data };
      idempotency.set(`${data.userId}:${data.key}`, row);
      return row;
    }),
  };
  const commerceOrder = {
    create: vi.fn(async ({ data }: any) => {
      const order = {
        id: ORDER_ID,
        ...data,
        createdAt: new Date('2026-10-01T10:00:00Z'),
        updatedAt: new Date('2026-10-01T10:00:00Z'),
        items: data.items.create.map((item: any, index: number) => ({ id: `item-${index}`, ...item })),
        statusHistory: [{ status: 'CREATED', note: null, createdAt: new Date('2026-10-01T10:00:00Z') }],
      };
      orders.push(order);
      return { id: order.id };
    }),
    findUnique: vi.fn(async ({ where }: any) => orders.find((order) =>
      where.id ? order.id === where.id : order.orderNumber === where.orderNumber) ?? null),
    findFirst: vi.fn(async ({ where }: any) => orders.find((order) =>
      order.orderNumber === where.orderNumber && order.userId === where.userId) ?? null),
    findMany: vi.fn(async ({ where }: any) => orders.filter((order) => !where?.userId || order.userId === where.userId)),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const order = orders.find((candidate) => candidate.id === where.id && candidate.status === where.status);
      if (!order) return { count: 0 };
      Object.assign(order, data);
      return { count: 1 };
    }),
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    commerceCart,
    commerceCartItem,
    commerceProduct,
    commerceProductVariant,
    commerceCheckoutIdempotency,
    commerceOrder,
    commerceOrderStatusHistory: {
      create: vi.fn(async ({ data }: any) => {
        statusHistory.push(data);
        return data;
      }),
    },
  };
  const prisma = {
    ...tx,
    user: {
      findUnique: vi.fn(async ({ where }: any) => ({
        id: where.id,
        role: where.id === ADMIN ? 'ADMIN' : 'USER',
        adminRole: where.id === ADMIN ? 'SUPER_ADMIN' : null,
        isBlocked: false,
        isDeleted: false,
      })),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      const productSnapshot = structuredClone([...products.entries()]);
      const cartItemsSnapshot = structuredClone(cartItems);
      const ordersSnapshot = structuredClone(orders);
      const idempotencySnapshot = structuredClone([...idempotency.entries()]);
      const historySnapshot = structuredClone(statusHistory);
      try {
        return await callback(tx);
      } catch (error) {
        products.clear();
        for (const [productId, product] of productSnapshot) products.set(productId, product);
        cartItems.splice(0, cartItems.length, ...cartItemsSnapshot);
        orders.splice(0, orders.length, ...ordersSnapshot);
        idempotency.clear();
        for (const [idempotencyKey, row] of idempotencySnapshot) idempotency.set(idempotencyKey, row);
        statusHistory.splice(0, statusHistory.length, ...historySnapshot);
        throw error;
      }
    }),
  };
  const app = Fastify();
  app.register(fastifyJwt, { secret: JWT_SECRET });
  app.decorate('prisma', prisma as never);
  app.register(cartCheckoutModule, { prefix: '/api/v1' });
  app.register(commerceOrdersModule, { prefix: '/api/v1' });
  return { app, prisma, products, cartItems, carts, orders, statusHistory };
}

async function tokenFor(app: ReturnType<typeof Fastify>, userId: string) {
  await app.ready();
  return app.jwt.sign({ userId, role: userId === ADMIN ? 'ADMIN' : 'USER' });
}

describe('commerce cart and checkout API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('derives cart ownership only from the authenticated user', async () => {
    const { app, prisma } = createTestApp();
    const tokenA = await tokenFor(app, USER_A);
    const tokenB = app.jwt.sign({ userId: USER_B, role: 'USER' });
    await app.inject({ method: 'GET', url: '/api/v1/cart', headers: { authorization: `Bearer ${tokenA}` } });
    await app.inject({ method: 'GET', url: '/api/v1/cart', headers: { authorization: `Bearer ${tokenB}` } });

    expect(prisma.commerceCart.upsert).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: { userId: USER_A } }));
    expect(prisma.commerceCart.upsert).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: { userId: USER_B } }));
    await app.close();
  });

  it('does not expose or mutate another customer cart items', async () => {
    const item = {
      id: 'customer-b-item',
      cartId: CART_B,
      itemKey: `${PRODUCT}:none`,
      productId: PRODUCT,
      variantId: null,
      quantity: 2,
    };
    const { app, prisma, cartItems } = createTestApp({ cartItems: [item] });
    const tokenA = await tokenFor(app, USER_A);
    const tokenB = await tokenFor(app, USER_B);
    const customerACart = await app.inject({
      method: 'GET',
      url: '/api/v1/cart',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const customerBCart = await app.inject({
      method: 'GET',
      url: '/api/v1/cart',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const update = await app.inject({
      method: 'PATCH',
      url: '/api/v1/cart/items/customer-b-item',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { quantity: 1 },
    });
    const remove = await app.inject({
      method: 'DELETE',
      url: '/api/v1/cart/items/customer-b-item',
      headers: { authorization: `Bearer ${tokenA}` },
    });

    expect(customerACart.statusCode).toBe(200);
    expect(customerACart.json().items).toEqual([]);
    expect(customerBCart.json().items).toEqual([expect.objectContaining({ id: item.id, quantity: 2 })]);
    expect(update.statusCode).toBe(404);
    expect(remove.statusCode).toBe(404);
    expect(prisma.commerceCartItem.updateMany).not.toHaveBeenCalled();
    expect(cartItems).toEqual([item]);
    await app.close();
  });

  it('does not check out another customer cart', async () => {
    const item = {
      id: 'customer-a-item',
      cartId: CART,
      itemKey: `${PRODUCT}:none`,
      productId: PRODUCT,
      variantId: null,
      quantity: 1,
    };
    const { app, prisma, cartItems, orders } = createTestApp({ cartItems: [item] });
    const tokenB = await tokenFor(app, USER_B);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      headers: { authorization: `Bearer ${tokenB}`, 'idempotency-key': 'foreign-cart-key-123' },
      payload: {
        contact: { name: 'Buyer B', phone: '+998901234568' },
        deliveryAddress: { city: 'Tashkent', address: 'Street 2' },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('CART_EMPTY');
    expect(prisma.commerceOrder.create).not.toHaveBeenCalled();
    expect(cartItems).toEqual([item]);
    expect(orders).toHaveLength(0);
    await app.close();
  });

  it('rejects unpublished products and malformed quantities', async () => {
    const { app, prisma } = createTestApp({ products: { [PRODUCT]: makeProduct({ status: 'DRAFT' }) } });
    const token = await tokenFor(app, USER_A);
    const hidden = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: { authorization: `Bearer ${token}` },
      payload: { productId: PRODUCT, quantity: 1 },
    });
    expect(hidden.statusCode).toBe(400);
    expect(hidden.json().code).toBe('PRODUCT_NOT_AVAILABLE');
    for (const quantity of [0, -1, 1.5, 100, Number.NaN, '2', null]) {
      const invalidQuantity = await app.inject({
        method: 'POST',
        url: '/api/v1/cart/items',
        headers: { authorization: `Bearer ${token}` },
        payload: { productId: PRODUCT, quantity },
      });
      expect(invalidQuantity.statusCode, `quantity ${String(quantity)}`).toBe(400);
      expect(invalidQuantity.json().code).toBe('INVALID_CART_ITEM');
    }
    expect(prisma.commerceCartItem.upsert).not.toHaveBeenCalled();
    await app.close();
  });

  it('uses the selected active variant price and stock instead of product-level values', async () => {
    const { app, prisma } = createTestApp({
      products: {
        [PRODUCT]: makeProduct({
          stock: 0,
          price: '99000.00',
          variants: [{
            id: VARIANT,
            productId: PRODUCT,
            active: true,
            color: 'Blue',
            size: 'M',
            sku: 'SKU-BLUE-M',
            salePriceUzs: '17500.00',
            stock: 2,
          }],
        }),
      },
    });
    const token = await tokenFor(app, USER_A);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: { authorization: `Bearer ${token}` },
      payload: { productId: PRODUCT, variantId: VARIANT, quantity: 1 },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().items[0]).toMatchObject({
      variantId: VARIANT,
      title: 'Куртка (Blue, M)',
      imageUrl: 'https://cdn.example/jacket.jpg',
      variant: { color: 'Blue', size: 'M', sku: 'SKU-BLUE-M' },
      quantity: 1,
      unitPriceUzs: '17500.00',
      lineTotalUzs: '17500.00',
      stock: 2,
      available: true,
    });
    expect(response.json()).toMatchObject({ subtotalUzs: '17500.00', currency: 'UZS' });
    expect(prisma.commerceCartItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ variantId: VARIANT, quantity: 1 }),
    }));
    await app.close();
  });

  it('rejects client-supplied prices rather than accepting a tampered checkout', async () => {
    const { app, prisma } = createTestApp();
    const token = await tokenFor(app, USER_A);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'price-tamper-123' },
      payload: {
        contact: { name: 'Buyer', phone: '+998901234567' },
        deliveryAddress: { city: 'Tashkent', address: 'Main street 1' },
        unitPrice: 1,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it('prices from the catalog, snapshots the order, consumes the cart, and replays idempotently', async () => {
    const { app, prisma, cartItems, products, orders } = createTestApp({
      cartItems: [{ id: 'cart-item', cartId: CART, itemKey: `${PRODUCT}:none`, productId: PRODUCT, variantId: null, quantity: 2 }],
    });
    const token = await tokenFor(app, USER_A);
    const payload = {
      contact: { name: 'Buyer', phone: '+998901234567' },
      deliveryAddress: { city: 'Tashkent', address: 'Main street 1', floor: '2', comment: 'Call on arrival' },
    };
    const headers = { authorization: `Bearer ${token}`, 'idempotency-key': 'order-submit-123' };
    const first = await app.inject({ method: 'POST', url: '/api/v1/checkout', headers, payload });
    const second = await app.inject({ method: 'POST', url: '/api/v1/checkout', headers, payload });

    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toEqual(expect.objectContaining({
      orderNumber: expect.any(String),
      status: 'CREATED',
      currency: 'UZS',
      subtotal: 25000,
      discount: 0,
      deliveryCost: 0,
      totalRevenue: 25000,
      createdAt: expect.any(String),
      items: [expect.objectContaining({ title: 'Куртка', quantity: 2, unitPrice: 12500, totalPrice: 25000 })],
    }));
    expect(first.json()).not.toHaveProperty('id');
    expect(first.json().items[0]).not.toHaveProperty('productId');
    expect(first.json()).not.toHaveProperty('contact');
    expect(first.json()).not.toHaveProperty('deliveryAddress');
    expect(first.json()).not.toHaveProperty('purchaseCost');
    expect(prisma.commerceOrder.create.mock.calls[0][0].data.deliveryAddress).toEqual({
      city: 'Tashkent',
      address: 'Main street 1',
      floor: '2',
      comment: 'Call on arrival',
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().orderNumber).toBe(first.json().orderNumber);
    expect(orders).toHaveLength(1);
    expect(cartItems).toHaveLength(0);
    expect(products.get(PRODUCT).stock).toBe(3);
    expect(prisma.commerceOrder.create.mock.calls[0][0].data.items.create[0].variantSnapshot).toBeUndefined();
    expect(prisma.commerceOrder.create).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('rejects a same-key request with different details', async () => {
    const { app } = createTestApp({
      cartItems: [{ id: 'cart-item', cartId: CART, itemKey: `${PRODUCT}:none`, productId: PRODUCT, variantId: null, quantity: 1 }],
    });
    const token = await tokenFor(app, USER_A);
    const headers = { authorization: `Bearer ${token}`, 'idempotency-key': 'same-key-1234' };
    const first = await app.inject({
      method: 'POST', url: '/api/v1/checkout', headers,
      payload: { contact: { name: 'Buyer', phone: '+998901234567' }, deliveryAddress: { city: 'Tashkent', address: 'Street 1' } },
    });
    const second = await app.inject({
      method: 'POST', url: '/api/v1/checkout', headers,
      payload: { contact: { name: 'Buyer', phone: '+998901234568' }, deliveryAddress: { city: 'Tashkent', address: 'Street 1' } },
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode).toBe(409);
    await app.close();
  });

  it('returns an immutable variant snapshot with a variant checkout', async () => {
    const { app, prisma } = createTestApp({
      products: {
        [PRODUCT]: makeProduct({
          variants: [{
            id: VARIANT,
            productId: PRODUCT,
            active: true,
            color: 'Blue',
            size: 'M',
            sku: 'SKU-BLUE-M',
            salePriceUzs: '17500.00',
            stock: 2,
          }],
        }),
      },
      cartItems: [{
        id: 'cart-item',
        cartId: CART,
        itemKey: `${PRODUCT}:${VARIANT}`,
        productId: PRODUCT,
        variantId: VARIANT,
        quantity: 1,
      }],
    });
    const token = await tokenFor(app, USER_A);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'variant-checkout-123' },
      payload: {
        contact: { name: 'Buyer', phone: '+998901234567' },
        deliveryAddress: { city: 'Tashkent', address: 'Main street 1' },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().items[0].variantSnapshot).toEqual({
      color: 'Blue',
      size: 'M',
      sku: 'SKU-BLUE-M',
    });
    expect(prisma.commerceOrder.create.mock.calls[0][0].data.items.create[0].variantSnapshot).toEqual({
      color: 'Blue',
      size: 'M',
      sku: 'SKU-BLUE-M',
    });
    await app.close();
  });

  it('rechecks and does not oversell stock during checkout', async () => {
    const { app, prisma, cartItems } = createTestApp({
      products: { [PRODUCT]: makeProduct({ stock: 1 }) },
      cartItems: [{ id: 'cart-item', cartId: CART, itemKey: `${PRODUCT}:none`, productId: PRODUCT, variantId: null, quantity: 2 }],
    });
    const token = await tokenFor(app, USER_A);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'stock-check-1234' },
      payload: { contact: { name: 'Buyer', phone: '+998901234567' }, deliveryAddress: { city: 'Tashkent', address: 'Street 1' } },
    });
    expect(response.statusCode).toBe(409);
    expect(prisma.commerceOrder.create).not.toHaveBeenCalled();
    expect(cartItems).toHaveLength(1);
    await app.close();
  });

  it('rolls back earlier stock claims when a later cart line cannot be fulfilled', async () => {
    const firstItem = {
      id: 'cart-item-1',
      cartId: CART,
      itemKey: `${PRODUCT}:none`,
      productId: PRODUCT,
      variantId: null,
      quantity: 1,
    };
    const secondItem = {
      id: 'cart-item-2',
      cartId: CART,
      itemKey: `${SECOND_PRODUCT}:none`,
      productId: SECOND_PRODUCT,
      variantId: null,
      quantity: 1,
    };
    const { app, prisma, products, cartItems, orders } = createTestApp({
      products: {
        [PRODUCT]: makeProduct({ stock: 5 }),
        [SECOND_PRODUCT]: makeProduct({ id: SECOND_PRODUCT, stock: 0 }),
      },
      cartItems: [firstItem, secondItem],
    });
    const token = await tokenFor(app, USER_A);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'partial-stock-claim-123' },
      payload: {
        contact: { name: 'Buyer', phone: '+998901234567' },
        deliveryAddress: { city: 'Tashkent', address: 'Street 1' },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('INSUFFICIENT_STOCK');
    expect(products.get(PRODUCT).stock).toBe(5);
    expect(cartItems).toHaveLength(2);
    expect(orders).toHaveLength(0);
    expect(prisma.commerceOrder.create).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('commerce order ownership and admin workflow', () => {
  it('does not return another customer order', async () => {
    const { app, prisma } = createTestApp({
      initialOrders: [{
        id: ORDER_ID,
        orderNumber: 'AV-OTHER-1',
        userId: USER_A,
        status: 'CREATED',
        currency: 'UZS',
        subtotal: '100.00',
        discount: '0.00',
        deliveryCost: '0.00',
        totalRevenue: '100.00',
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [],
        statusHistory: [],
      }],
    });
    const token = await tokenFor(app, USER_B);
    const ownerToken = app.jwt.sign({ userId: USER_A, role: 'USER' });
    const ownerList = await app.inject({
      method: 'GET',
      url: '/api/v1/orders/me',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(ownerList.statusCode).toBe(200);
    expect(ownerList.json()[0]).toMatchObject({ orderNumber: 'AV-OTHER-1' });
    expect(ownerList.json()[0]).toMatchObject({ subtotal: 100, discount: 0, deliveryCost: 0 });
    expect(ownerList.json()[0]).not.toHaveProperty('id');
    expect(ownerList.json()[0].items[0] ?? {}).not.toHaveProperty('id');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/orders/me/AV-OTHER-1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(404);
    expect(prisma.commerceOrder.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { orderNumber: 'AV-OTHER-1', userId: USER_B },
    }));
    await app.close();
  });

  it('requires admin authorization and permits only CREATED to CONFIRMED or CANCELLED', async () => {
    const order = {
      id: ORDER_ID,
      orderNumber: 'AV-TEST-1',
      userId: USER_A,
      status: 'CREATED',
      currency: 'UZS',
      subtotal: '20000.00',
      discount: '0.00',
      deliveryCost: '0.00',
      totalRevenue: '20000.00',
      contact: { name: 'Buyer', phone: '+998901234567' },
      deliveryAddress: { city: 'Tashkent', address: 'Street 1' },
      createdAt: new Date(),
      updatedAt: new Date(),
      items: [],
    };
    const { app, prisma, orders } = createTestApp({ initialOrders: [order] });
    const userToken = await tokenFor(app, USER_A);
    const denied = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/orders/AV-TEST-1/status',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { status: 'CONFIRMED' },
    });
    expect(denied.statusCode).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();

    const adminToken = await tokenFor(app, ADMIN);
    const changed = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/orders/AV-TEST-1/status',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'CONFIRMED' },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().status).toBe('CONFIRMED');
    expect(changed.json()).not.toHaveProperty('payments');

    const secondTransition = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/orders/AV-TEST-1/status',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'CANCELLED' },
    });
    expect(secondTransition.statusCode).toBe(409);

    const invalid = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/orders/AV-TEST-1/status',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'PAID' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(orders[0].status).toBe('CONFIRMED');
    expect(prisma.commerceOrderStatusHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'CONFIRMED', actorId: ADMIN }),
    }));
    await app.close();
  });

  it('restores inventory in the same transaction when an unfulfilled order is cancelled', async () => {
    const { app, products, orders } = createTestApp({
      initialOrders: [{
        id: ORDER_ID,
        orderNumber: 'AV-CANCEL-1',
        userId: USER_A,
        status: 'CREATED',
        inventoryCommitted: true,
        currency: 'UZS',
        subtotal: '25000.00',
        discount: '0.00',
        deliveryCost: '0.00',
        totalRevenue: '25000.00',
        contact: { name: 'Buyer', phone: '+998901234567' },
        deliveryAddress: { city: 'Tashkent', address: 'Street 1' },
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [{
          id: 'order-item-1',
          productId: PRODUCT,
          variantId: null,
          variantSnapshot: null,
          quantity: 2,
          title: 'Куртка',
          unitPrice: '12500.00',
          totalPrice: '25000.00',
        }],
      }],
    });
    const adminToken = await tokenFor(app, ADMIN);
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/orders/AV-CANCEL-1/status',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'CANCELLED' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('CANCELLED');
    expect(products.get(PRODUCT).stock).toBe(7);
    expect(orders[0].inventoryCommitted).toBe(true);
    await app.close();
  });
});
