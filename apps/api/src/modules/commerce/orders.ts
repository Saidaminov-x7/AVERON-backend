import type { AveronOrderStatus, CommerceDeliveryStatus, Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { adminMiddleware } from '../../lib/adminMiddleware';
import { authMiddleware } from '../../lib/authMiddleware';

const statusSchema = z.object({
  status: z.enum([
    'CONFIRMED',
    'CANCELLED',
    'PAID',
    'ORDERED_FROM_SUPPLIER',
    'SUPPLIER_CONFIRMED',
    'IN_TRANSIT_CHINA',
    'CARGO_WAREHOUSE',
    'INTERNATIONAL_TRANSIT',
    'ARRIVED_UZBEKISTAN',
    'OUT_FOR_DELIVERY',
    'DELIVERED',
    'COMPLETED',
  ]),
  note: z.string().trim().max(500).optional(),
}).strict();

const deliveryUpdateSchema = z.object({
  status: z.enum([
    'PENDING',
    'PREPARING',
    'SHIPPED',
    'IN_TRANSIT',
    'READY_FOR_DELIVERY',
    'DELIVERED',
    'CANCELLED',
  ]),
  trackingNumber: z.string().trim().min(1).max(160).nullable().optional(),
  provider: z.string().trim().min(1).max(100).nullable().optional(),
  estimatedDeliveryAt: z.string().datetime().nullable().optional(),
  note: z.string().trim().max(500).optional(),
}).strict();

const allowedTransitions: Partial<Record<AveronOrderStatus, readonly AveronOrderStatus[]>> = {
  CREATED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PAID'],
  PAID: ['ORDERED_FROM_SUPPLIER'],
  ORDERED_FROM_SUPPLIER: ['SUPPLIER_CONFIRMED'],
  SUPPLIER_CONFIRMED: ['IN_TRANSIT_CHINA'],
  IN_TRANSIT_CHINA: ['CARGO_WAREHOUSE'],
  CARGO_WAREHOUSE: ['INTERNATIONAL_TRANSIT'],
  INTERNATIONAL_TRANSIT: ['ARRIVED_UZBEKISTAN'],
  ARRIVED_UZBEKISTAN: ['OUT_FOR_DELIVERY'],
  OUT_FOR_DELIVERY: ['DELIVERED'],
  DELIVERED: ['COMPLETED'],
};

const allowedDeliveryTransitions: Record<CommerceDeliveryStatus, readonly CommerceDeliveryStatus[]> = {
  PENDING: ['PREPARING', 'CANCELLED'],
  PREPARING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['IN_TRANSIT'],
  IN_TRANSIT: ['READY_FOR_DELIVERY'],
  READY_FOR_DELIVERY: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

const purchaseShipmentSelect = {
  shipments: {
    select: {
      shipment: {
        select: {
          provider: true,
          trackingNumber: true,
          status: true,
          sentAt: true,
          arrivedAt: true,
        },
      },
    },
  },
} satisfies Prisma.SupplierPurchaseSelect;

const customerDeliverySelect = {
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
} satisfies Prisma.CommerceDeliverySelect;

const adminDeliverySelect = {
  ...customerDeliverySelect,
  history: {
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: { status: true, note: true, createdAt: true },
  },
} satisfies Prisma.CommerceDeliverySelect;

function jsonStringField(value: Prisma.JsonValue | null, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const field = value[key];
  return typeof field === 'string' && field.trim() ? field.trim() : null;
}

const customerOrderSelect = {
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
      isPreorder: true,
      preorderEstimatedAt: true,
    },
  },
  statusHistory: {
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { status: true, createdAt: true },
  },
  purchases: { select: purchaseShipmentSelect },
  delivery: { select: customerDeliverySelect },
} satisfies Prisma.CommerceOrderSelect;

const adminOrderSelect = {
  id: true,
  orderNumber: true,
  status: true,
  currency: true,
  subtotal: true,
  discount: true,
  deliveryCost: true,
  totalRevenue: true,
  contact: true,
  deliveryAddress: true,
  createdAt: true,
  updatedAt: true,
  statusHistory: {
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { status: true, note: true, createdAt: true },
  },
  purchases: { select: purchaseShipmentSelect },
  delivery: { select: adminDeliverySelect },
  items: {
    select: {
      id: true,
      productId: true,
      variantId: true,
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

function amount(value: Prisma.Decimal | number): number {
  return Number(value);
}

type CustomerOrderSource = Prisma.CommerceOrderGetPayload<{ select: typeof customerOrderSelect }>;

function shipmentDtos(
  purchases: Array<Prisma.SupplierPurchaseGetPayload<{ select: typeof purchaseShipmentSelect }>> | undefined,
) {
  const shipments = new Map<string, {
    provider: string;
    trackingNumber: string;
    status: string;
    sentAt: Date | null;
    arrivedAt: Date | null;
  }>();
  for (const purchase of purchases ?? []) {
    for (const { shipment } of purchase.shipments) {
      shipments.set(shipment.trackingNumber, {
        provider: shipment.provider,
        trackingNumber: shipment.trackingNumber,
        status: shipment.status,
        sentAt: shipment.sentAt,
        arrivedAt: shipment.arrivedAt,
      });
    }
  }
  return [...shipments.values()];
}

function customerOrderDto(order: CustomerOrderSource) {
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    currency: order.currency,
    subtotal: amount(order.subtotal),
    discount: amount(order.discount),
    deliveryCost: amount(order.deliveryCost),
    totalRevenue: amount(order.totalRevenue),
    createdAt: order.createdAt,
    items: order.items.map((item) => ({
      title: item.title,
      ...(item.variantSnapshot ? { variantSnapshot: item.variantSnapshot } : {}),
      quantity: item.quantity,
      unitPrice: amount(item.unitPrice),
      totalPrice: amount(item.totalPrice),
      isPreorder: item.isPreorder,
      ...(item.isPreorder ? { estimatedAvailableAt: item.preorderEstimatedAt } : {}),
    })),
    statusHistory: order.statusHistory.map(({ status, createdAt }) => ({ status, createdAt })),
    shipments: shipmentDtos(order.purchases),
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
      history: order.delivery.history.map(({ status, createdAt }) => ({ status, createdAt })),
    } : null,
  };
}

async function findOrderForDto(app: FastifyInstance, orderNumber: string, userId: string) {
  return app.prisma.commerceOrder.findFirst({
    where: { orderNumber, userId },
    select: customerOrderSelect,
  });
}

type AdminOrderSource = Prisma.CommerceOrderGetPayload<{ select: typeof adminOrderSelect }>;

function adminOrderDto(order: AdminOrderSource) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status as AveronOrderStatus,
    currency: order.currency,
    subtotal: amount(order.subtotal),
    discount: amount(order.discount),
    deliveryCost: amount(order.deliveryCost),
    totalRevenue: amount(order.totalRevenue),
    contact: order.contact,
    deliveryAddress: order.deliveryAddress,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    statusHistory: order.statusHistory,
    shipments: shipmentDtos(order.purchases),
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
    items: order.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      variantId: item.variantId,
      title: item.title,
      ...(item.variantSnapshot ? { variantSnapshot: item.variantSnapshot } : {}),
      quantity: item.quantity,
      unitPrice: amount(item.unitPrice),
      totalPrice: amount(item.totalPrice),
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

class OrderTransitionFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

type InventoryItem = {
  productId: string;
  variantId: string | null;
  variantSnapshot: Prisma.JsonValue | null;
  quantity: number;
  isPreorder: boolean;
};

async function restoreOrderInventory(tx: Prisma.TransactionClient, items: InventoryItem[]) {
  if (items.some((item) => item.variantSnapshot !== null && item.variantId === null)) {
    throw new OrderTransitionFailure('CANCELLATION_STOCK_UNAVAILABLE');
  }
  for (const item of items) {
    const restored = item.isPreorder
      ? await tx.commerceProduct.updateMany({
        where: { id: item.productId, preorderReserved: { gte: item.quantity } },
        data: { preorderReserved: { decrement: item.quantity } },
      })
      : item.variantId
        ? await tx.commerceProductVariant.updateMany({
          where: { id: item.variantId, productId: item.productId },
          data: { stock: { increment: item.quantity } },
        })
        : await tx.commerceProduct.updateMany({
          where: { id: item.productId },
          data: { stock: { increment: item.quantity } },
        });
    if (restored.count !== 1) throw new OrderTransitionFailure('CANCELLATION_STOCK_UNAVAILABLE');
  }
}

async function cancelPendingDelivery(
  tx: Prisma.TransactionClient,
  delivery: { id: string; status: CommerceDeliveryStatus } | null,
  changedBy: string,
) {
  if (!delivery || delivery.status === 'CANCELLED') return;
  if (delivery.status !== 'PENDING') throw new OrderTransitionFailure('ORDER_DELIVERY_NOT_CANCELLABLE');
  const updated = await tx.commerceDelivery.updateMany({
    where: { id: delivery.id, status: 'PENDING' },
    data: { status: 'CANCELLED' },
  });
  if (updated.count !== 1) throw new OrderTransitionFailure('ORDER_DELIVERY_NOT_CANCELLABLE');
  await tx.commerceDeliveryStatusHistory.create({
    data: { deliveryId: delivery.id, status: 'CANCELLED', changedBy },
  });
}

export const commerceOrdersModule: FastifyPluginAsync = async (app) => {
  app.get('/orders/me', { preHandler: authMiddleware }, async (request, reply) => {
    try {
      const orders = await app.prisma.commerceOrder.findMany({
        where: { userId: request.user.userId },
        select: customerOrderSelect,
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return orders.map((order) => customerOrderDto(order));
    } catch (error) {
      request.log.error({ error }, 'Unable to list customer orders');
      return reply.status(500).send({ code: 'ORDER_LIST_FAILED', message: 'Unable to load orders' });
    }
  });

  app.get<{ Params: { orderNumber: string } }>('/orders/me/:orderNumber', {
    preHandler: authMiddleware,
  }, async (request, reply) => {
    try {
      const order = await findOrderForDto(app, request.params.orderNumber, request.user.userId);
      if (!order) return reply.status(404).send({ code: 'ORDER_NOT_FOUND', message: 'Order not found' });
      return customerOrderDto(order);
    } catch (error) {
      request.log.error({ error }, 'Unable to load customer order');
      return reply.status(500).send({ code: 'ORDER_LOAD_FAILED', message: 'Unable to load order' });
    }
  });

  app.post<{ Params: { orderNumber: string } }>('/orders/me/:orderNumber/cancel', {
    preHandler: authMiddleware,
  }, async (request, reply) => {
    try {
      const order = await app.prisma.$transaction(async (tx) => {
        const current = await tx.commerceOrder.findFirst({
          where: { orderNumber: request.params.orderNumber, userId: request.user.userId },
          select: {
            id: true,
            status: true,
            inventoryCommitted: true,
            delivery: { select: { id: true, status: true } },
            items: {
              select: {
                productId: true,
                variantId: true,
                variantSnapshot: true,
                quantity: true,
                isPreorder: true,
              },
            },
          },
        });
        if (!current) return { error: 'ORDER_NOT_FOUND' as const };
        if (current.status !== 'CREATED') return { error: 'INVALID_ORDER_STATUS_TRANSITION' as const };
        if (current.inventoryCommitted) await restoreOrderInventory(tx, current.items);
        await cancelPendingDelivery(tx, current.delivery, request.user.userId);
        const changed = await tx.commerceOrder.updateMany({
          where: { id: current.id, status: 'CREATED' },
          data: { status: 'CANCELLED' },
        });
        if (changed.count !== 1) return { error: 'INVALID_ORDER_STATUS_TRANSITION' as const };
        await tx.commerceOrderStatusHistory.create({
          data: { orderId: current.id, status: 'CANCELLED', actorId: request.user.userId },
        });
        return {
          order: await tx.commerceOrder.findUnique({
            where: { id: current.id },
            select: customerOrderSelect,
          }),
        };
      });
      if ('error' in order) {
        if (order.error === 'ORDER_NOT_FOUND') return reply.status(404).send({ code: order.error, message: 'Order not found' });
        return reply.status(409).send({ code: order.error, message: 'This order can no longer be cancelled' });
      }
      if (!order.order) return reply.status(500).send({ code: 'ORDER_LOAD_FAILED', message: 'Unable to load cancelled order' });
      return customerOrderDto(order.order);
    } catch (error) {
      if (error instanceof OrderTransitionFailure) {
        return reply.status(409).send({ code: error.code, message: 'Order could not be safely cancelled' });
      }
      request.log.error({ error }, 'Unable to cancel customer order');
      return reply.status(500).send({ code: 'ORDER_CANCEL_FAILED', message: 'Unable to cancel order' });
    }
  });

  app.get('/admin/orders', { preHandler: adminMiddleware }, async (request, reply) => {
    try {
      const orders = await app.prisma.commerceOrder.findMany({
        select: adminOrderSelect,
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return orders.map(adminOrderDto);
    } catch (error) {
      request.log.error({ error }, 'Unable to list admin orders');
      return reply.status(500).send({ code: 'ORDER_LIST_FAILED', message: 'Unable to load orders' });
    }
  });

  app.patch<{ Params: { orderNumber: string } }>('/admin/orders/:orderNumber/shipping', {
    preHandler: adminMiddleware,
  }, async (request, reply) => {
    const parsed = deliveryUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_SHIPPING_DETAILS', message: 'Invalid shipping details' });
    try {
      const result = await app.prisma.$transaction(async (tx) => {
        const current = await tx.commerceOrder.findUnique({
          where: { orderNumber: request.params.orderNumber },
          select: {
            id: true,
            contact: true,
            deliveryAddress: true,
            delivery: { select: { id: true, status: true, shippedAt: true, deliveredAt: true } },
          },
        });
        if (!current) return { error: 'ORDER_NOT_FOUND' as const };
        let delivery = current.delivery;
        if (!delivery) {
          const recipient = jsonStringField(current.contact, 'name');
          const phone = jsonStringField(current.contact, 'phone');
          const city = jsonStringField(current.deliveryAddress, 'city');
          const address = jsonStringField(current.deliveryAddress, 'address');
          if (!recipient || !phone || !city || !address) {
            return { error: 'DELIVERY_CONTACT_MISSING' as const };
          }
          delivery = await tx.commerceDelivery.create({
            data: {
              orderId: current.id,
              method: 'COURIER',
              recipient,
              phone,
              destination: current.deliveryAddress as Prisma.InputJsonValue,
              history: { create: { status: 'PENDING', changedBy: request.user.userId } },
            },
            select: { id: true, status: true, shippedAt: true, deliveredAt: true },
          });
        }
        const currentStatus = delivery.status as CommerceDeliveryStatus;
        if (parsed.data.status !== currentStatus
          && !allowedDeliveryTransitions[currentStatus]?.includes(parsed.data.status as CommerceDeliveryStatus)) {
          return { error: 'INVALID_SHIPPING_TRANSITION' as const };
        }
        const changed = await tx.commerceDelivery.updateMany({
          where: { id: delivery.id, status: currentStatus },
          data: {
            status: parsed.data.status,
            ...(parsed.data.trackingNumber !== undefined ? { trackingNumber: parsed.data.trackingNumber } : {}),
            ...(parsed.data.provider !== undefined ? { provider: parsed.data.provider } : {}),
            ...(parsed.data.estimatedDeliveryAt !== undefined
              ? { estimatedDeliveryAt: parsed.data.estimatedDeliveryAt ? new Date(parsed.data.estimatedDeliveryAt) : null }
              : {}),
            ...(parsed.data.status === 'SHIPPED' && delivery.shippedAt === null ? { shippedAt: new Date() } : {}),
            ...(parsed.data.status === 'DELIVERED' && delivery.deliveredAt === null ? { deliveredAt: new Date() } : {}),
          },
        });
        if (changed.count !== 1) return { error: 'INVALID_SHIPPING_TRANSITION' as const };
        if (parsed.data.status !== currentStatus) {
          await tx.commerceDeliveryStatusHistory.create({
            data: {
              deliveryId: delivery.id,
              status: parsed.data.status,
              note: parsed.data.note,
              changedBy: request.user.userId,
            },
          });
        }
        return {
          order: await tx.commerceOrder.findUnique({
            where: { id: current.id },
            select: adminOrderSelect,
          }),
        };
      });
      if ('error' in result) {
        if (result.error === 'ORDER_NOT_FOUND') return reply.status(404).send({ code: result.error, message: 'Order not found' });
        if (result.error === 'DELIVERY_CONTACT_MISSING') return reply.status(409).send({ code: result.error, message: 'Order contact and address are required to initialize delivery' });
        return reply.status(409).send({ code: result.error, message: 'Invalid shipping status transition' });
      }
      if (!result.order) return reply.status(500).send({ code: 'ORDER_LOAD_FAILED', message: 'Unable to load updated order' });
      return adminOrderDto(result.order);
    } catch (error) {
      if (errorCode(error) === 'P2002') {
        return reply.status(409).send({ code: 'TRACKING_NUMBER_CONFLICT', message: 'Tracking number is already assigned' });
      }
      request.log.error({ error }, 'Unable to update internal delivery');
      return reply.status(500).send({ code: 'SHIPPING_UPDATE_FAILED', message: 'Unable to update shipping details' });
    }
  });

  app.get<{ Params: { orderNumber: string } }>('/admin/orders/:orderNumber', {
    preHandler: adminMiddleware,
  }, async (request, reply) => {
    try {
      const order = await app.prisma.commerceOrder.findUnique({
        where: { orderNumber: request.params.orderNumber },
        select: adminOrderSelect,
      });
      if (!order) return reply.status(404).send({ code: 'ORDER_NOT_FOUND', message: 'Order not found' });
      return adminOrderDto(order);
    } catch (error) {
      request.log.error({ error }, 'Unable to load admin order');
      return reply.status(500).send({ code: 'ORDER_LOAD_FAILED', message: 'Unable to load order' });
    }
  });

  app.patch<{ Params: { orderNumber: string } }>('/admin/orders/:orderNumber/status', {
    preHandler: adminMiddleware,
  }, async (request, reply) => {
    const parsed = statusSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_ORDER_STATUS', message: 'Invalid order status' });
    try {
      const result = await app.prisma.$transaction(async (tx) => {
        const current = await tx.commerceOrder.findUnique({
          where: { orderNumber: request.params.orderNumber },
          select: {
            id: true,
            status: true,
            inventoryCommitted: true,
            delivery: { select: { id: true, status: true } },
            items: {
              select: {
                productId: true,
                variantId: true,
                variantSnapshot: true,
                quantity: true,
                isPreorder: true,
              },
            },
          },
        });
        if (!current) return { error: 'ORDER_NOT_FOUND' as const };
        if (!allowedTransitions[current.status as AveronOrderStatus]?.includes(parsed.data.status as AveronOrderStatus)) {
          return { error: 'INVALID_ORDER_STATUS_TRANSITION' as const };
        }
        if (parsed.data.status === 'CANCELLED' && current.inventoryCommitted) {
          await restoreOrderInventory(tx, current.items);
        }
        if (parsed.data.status === 'CANCELLED') {
          await cancelPendingDelivery(tx, current.delivery, request.user.userId);
        }
        const changed = await tx.commerceOrder.updateMany({
          where: { id: current.id, status: current.status },
          data: { status: parsed.data.status },
        });
        if (changed.count !== 1) throw new OrderTransitionFailure('INVALID_ORDER_STATUS_TRANSITION');
        await tx.commerceOrderStatusHistory.create({
          data: {
            orderId: current.id,
            status: parsed.data.status as AveronOrderStatus,
            note: parsed.data.note,
            actorId: request.user.userId,
          },
        });
        const updated = await tx.commerceOrder.findUnique({
          where: { id: current.id },
          select: adminOrderSelect,
        });
        return { order: updated };
      });
      if ('error' in result) {
        if (result.error === 'ORDER_NOT_FOUND') return reply.status(404).send({ code: result.error, message: 'Order not found' });
        return reply.status(409).send({ code: result.error, message: 'Invalid order status transition' });
      }
      if (!result.order) return reply.status(500).send({ code: 'ORDER_LOAD_FAILED', message: 'Unable to load updated order' });
      return adminOrderDto(result.order);
    } catch (error) {
      if (error instanceof OrderTransitionFailure) {
        return reply.status(409).send({ code: error.code, message: 'Order status transition could not be completed' });
      }
      if (errorCode(error) === 'P2025') return reply.status(404).send({ code: 'ORDER_NOT_FOUND', message: 'Order not found' });
      request.log.error({ error }, 'Unable to update order status');
      return reply.status(500).send({ code: 'ORDER_STATUS_UPDATE_FAILED', message: 'Unable to update order status' });
    }
  });
};
