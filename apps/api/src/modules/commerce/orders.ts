import type { AveronOrderStatus, Prisma } from '@prisma/client';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { adminMiddleware } from '../../lib/adminMiddleware';
import { authMiddleware } from '../../lib/authMiddleware';

const statusSchema = z.object({
  status: z.enum(['CONFIRMED', 'CANCELLED']),
}).strict();

const customerOrderSelect = {
  orderNumber: true,
  status: true,
  currency: true,
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
  statusHistory: {
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { status: true, note: true, createdAt: true },
  },
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
    },
  },
} satisfies Prisma.CommerceOrderSelect;

function amount(value: Prisma.Decimal | number): number {
  return Number(value);
}

type CustomerOrderSource = Prisma.CommerceOrderGetPayload<{ select: typeof customerOrderSelect }>;

function customerOrderDto(order: CustomerOrderSource) {
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    currency: order.currency,
    totalRevenue: amount(order.totalRevenue),
    createdAt: order.createdAt,
    items: order.items.map((item) => ({
      title: item.title,
      ...(item.variantSnapshot ? { variantSnapshot: item.variantSnapshot } : {}),
      quantity: item.quantity,
      unitPrice: amount(item.unitPrice),
      totalPrice: amount(item.totalPrice),
    })),
    statusHistory: order.statusHistory,
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
    items: order.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      variantId: item.variantId,
      title: item.title,
      ...(item.variantSnapshot ? { variantSnapshot: item.variantSnapshot } : {}),
      quantity: item.quantity,
      unitPrice: amount(item.unitPrice),
      totalPrice: amount(item.totalPrice),
    })),
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
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
      return reply.status(500).send({ message: 'Unable to load orders' });
    }
  });

  app.get<{ Params: { orderNumber: string } }>('/orders/me/:orderNumber', {
    preHandler: authMiddleware,
  }, async (request, reply) => {
    try {
      const order = await findOrderForDto(app, request.params.orderNumber, request.user.userId);
      if (!order) return reply.status(404).send({ message: 'Order not found' });
      return customerOrderDto(order);
    } catch (error) {
      request.log.error({ error }, 'Unable to load customer order');
      return reply.status(500).send({ message: 'Unable to load order' });
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
      return reply.status(500).send({ message: 'Unable to load orders' });
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
      if (!order) return reply.status(404).send({ message: 'Order not found' });
      return adminOrderDto(order);
    } catch (error) {
      request.log.error({ error }, 'Unable to load admin order');
      return reply.status(500).send({ message: 'Unable to load order' });
    }
  });

  app.patch<{ Params: { orderNumber: string } }>('/admin/orders/:orderNumber/status', {
    preHandler: adminMiddleware,
  }, async (request, reply) => {
    const parsed = statusSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ message: 'Invalid order status' });
    try {
      const result = await app.prisma.$transaction(async (tx) => {
        const current = await tx.commerceOrder.findUnique({
          where: { orderNumber: request.params.orderNumber },
          select: { id: true, status: true },
        });
        if (!current) return { error: 'ORDER_NOT_FOUND' as const };
        if (current.status !== 'CREATED') return { error: 'INVALID_STATUS_TRANSITION' as const };
        const changed = await tx.commerceOrder.updateMany({
          where: { id: current.id, status: 'CREATED' },
          data: { status: parsed.data.status },
        });
        if (changed.count !== 1) return { error: 'INVALID_STATUS_TRANSITION' as const };
        await tx.commerceOrderStatusHistory.create({
          data: {
            orderId: current.id,
            status: parsed.data.status,
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
        if (result.error === 'ORDER_NOT_FOUND') return reply.status(404).send({ message: 'Order not found' });
        return reply.status(409).send({ message: 'Invalid order status transition' });
      }
      if (!result.order) return reply.status(500).send({ message: 'Unable to load updated order' });
      return adminOrderDto(result.order);
    } catch (error) {
      if (errorCode(error) === 'P2025') return reply.status(404).send({ message: 'Order not found' });
      request.log.error({ error }, 'Unable to update order status');
      return reply.status(500).send({ message: 'Unable to update order status' });
    }
  });
};
