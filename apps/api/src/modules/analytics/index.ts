import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { adminMiddleware } from '../../lib/adminMiddleware';

const visitSchema = z.object({
  deviceId: z.string().uuid(),
  path: z.string().regex(/^\/(?:ru|uz|en)(?:\/[a-zA-Z0-9._~!$&'()*+,;=:@%-]*)*$/).max(512),
});

const commerceEventNames = [
  'page_view',
  'product_view',
  'catalog_search',
  'catalog_filter',
  'favorite_add',
  'favorite_remove',
  'compare_add',
  'compare_remove',
  'cart_add',
  'cart_remove',
  'begin_checkout',
  'promo_apply',
  'promo_reject',
  'purchase',
  'review_submit',
  'outfit_save',
  'outfit_add_to_cart',
  'wishlist_share_enable',
  'wishlist_share_open',
  'wishlist_share_disable',
  'telegram_transition',
] as const;

export const commerceEventSchema = z.object({
  eventId: z.string().uuid(),
  deviceId: z.string().uuid(),
  eventName: z.enum(commerceEventNames),
  path: visitSchema.shape.path,
  orderId: z.string().uuid().optional(),
  metadata: z.object({
    productId: z.string().uuid().optional(),
    categorySlug: z.string().max(100).optional(),
    country: z.enum(['CN', 'US', 'TR', 'IT', 'GB']).optional(),
    audience: z.enum(['all', 'women', 'men', 'kids']).optional(),
    queryLength: z.number().int().min(0).max(200).optional(),
    resultCount: z.number().int().min(0).max(10000).optional(),
    sort: z.enum(['popular', 'newest', 'price_asc', 'price_desc']).optional(),
    size: z.string().max(40).optional(),
    color: z.string().max(40).optional(),
    minPrice: z.number().int().min(0).max(100000000).optional(),
    maxPrice: z.number().int().min(0).max(100000000).optional(),
    quantity: z.number().int().min(1).max(100).optional(),
  }).strict().optional(),
}).strict().superRefine((event, context) => {
  if (event.eventName === 'purchase' && !event.orderId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['orderId'], message: 'Purchase events require an order ID' });
  }
  if (event.eventName === 'product_view' && !event.metadata?.productId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['metadata', 'productId'], message: 'Product views require a product ID' });
  }
  if (event.eventName !== 'purchase' && event.orderId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['orderId'], message: 'Order IDs are only valid for purchase events' });
  }
  if (
    event.eventName === 'wishlist_share_open'
    && !/^\/(?:ru|uz|en)\/wishlist\/shared$/.test(event.path)
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['path'], message: 'Shared wishlist paths must not contain access tokens' });
  }
  if (
    (event.eventName === 'wishlist_share_enable' || event.eventName === 'wishlist_share_disable')
    && !/^\/(?:ru|uz|en)\/favorites$/.test(event.path)
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['path'], message: 'Wishlist sharing events require a sanitized favorites path' });
  }
});

const dateRangeQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  days: z.coerce.number().min(1).max(365).optional().default(30),
});

const exportQuerySchema = dateRangeQuerySchema.extend({
  type: z.enum(['traffic', 'visitors', 'products', 'orders']).optional().default('traffic'),
});

const PAID_ORDER_STATUSES = [
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
] as const;

function getDateRange(query: z.infer<typeof dateRangeQuerySchema>) {
  if (query.from && query.to) {
    return {
      startDate: new Date(`${query.from}T00:00:00.000Z`),
      endDate: new Date(`${query.to}T23:59:59.999Z`),
    };
  }
  const endDate = new Date();
  return {
    startDate: new Date(endDate.getTime() - query.days * 24 * 60 * 60 * 1000),
    endDate,
  };
}

function isPrivatePath(path: string) {
  return /^\/(?:ru|uz|en)\/(?:login|register|forgot-password|reset-password|profile|cart|checkout|orders(?:\/|$)|favorites|compare|outfits|wishlist\/shared(?:\/|$)|mini-app)(?:\/|$)/.test(path);
}

function asNumber(value: { toString(): string } | number) {
  return Number(value.toString());
}

export const analyticsModule: FastifyPluginAsync = async (server) => {
  server.post('/events', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = commerceEventSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_ANALYTICS_EVENT' });
    const event = parsed.data;
    const isWishlistSharingEvent = event.eventName.startsWith('wishlist_share_');
    if ((isPrivatePath(event.path) && !isWishlistSharingEvent) || event.path.startsWith('/admin/') || event.path.startsWith('/api/')) {
      return reply.status(204).send();
    }

    let revenueUzs: Prisma.Decimal | undefined;
    if (event.eventName === 'purchase' && event.orderId) {
      const order = await server.prisma.commerceOrder.findUnique({
        where: { id: event.orderId },
        select: { status: true, totalRevenue: true, refundAmount: true },
      });
      if (!order || !PAID_ORDER_STATUSES.includes(order.status as typeof PAID_ORDER_STATUSES[number])) {
        return reply.status(204).send();
      }
      revenueUzs = new Prisma.Decimal(
        Math.max(0, asNumber(order.totalRevenue) - asNumber(order.refundAmount)),
      );
    }

    try {
      await server.prisma.commerceAnalyticsEvent.create({
        data: {
          eventId: event.eventId,
          eventName: event.eventName,
          deviceId: event.deviceId,
          ...(event.eventName === 'product_view' && event.metadata?.productId
            ? {
              productId: event.metadata.productId,
              productViewDayKey: new Date().toISOString().slice(0, 10),
            }
            : {}),
          path: event.path,
          metadata: event.metadata as Prisma.InputJsonValue | undefined,
          ...(event.orderId ? { orderId: event.orderId } : {}),
          ...(revenueUzs ? { revenueUzs } : {}),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return reply.status(204).send();
      }
      request.log.warn({ err: error }, 'Commerce analytics event could not be recorded');
      return reply.status(503).send({ code: 'ANALYTICS_UNAVAILABLE' });
    }
    return reply.status(204).send();
  });

  server.post('/visit', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = visitSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_ANALYTICS_EVENT' });
    const { deviceId, path } = parsed.data;
    if (isPrivatePath(path) || path.startsWith('/admin/') || path.startsWith('/api/')) {
      return reply.status(204).send();
    }

    const dayKey = new Date().toISOString().slice(0, 10);
    try {
      await server.prisma.visitLog.upsert({
        where: { deviceId_dayKey: { deviceId, dayKey } },
        update: { path },
        create: { deviceId, dayKey, path },
      });
    } catch (error) {
      request.log.warn({ err: error }, 'Analytics visit could not be recorded');
    }
    return reply.status(204).send();
  });

  server.get('/admin/visitors', { preHandler: [adminMiddleware] }, async (request, reply) => {
    const parsed = dateRangeQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_DATE_RANGE' });
    const { startDate, endDate } = getDateRange(parsed.data);
    const [visits, uniqueVisitors] = await Promise.all([
      server.prisma.visitLog.groupBy({
        by: ['dayKey'],
        where: { createdAt: { gte: startDate, lte: endDate } },
        _count: { id: true },
        orderBy: { dayKey: 'asc' },
      }),
      server.prisma.visitLog.groupBy({
        by: ['deviceId'],
        where: { createdAt: { gte: startDate, lte: endDate } },
      }),
    ]);
    return reply.send({
      from: startDate.toISOString().slice(0, 10),
      to: endDate.toISOString().slice(0, 10),
      totalVisitors: uniqueVisitors.length,
      daily: visits.map((item) => ({ date: item.dayKey, visitors: item._count.id })),
    });
  });

  server.get('/admin/range', { preHandler: [adminMiddleware] }, async (request, reply) => {
    const parsed = dateRangeQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_DATE_RANGE' });
    const { startDate, endDate } = getDateRange(parsed.data);
    const range = { gte: startDate, lte: endDate };
    const [visitorsByDay, uniqueVisitors, products, users, paidOrders] = await Promise.all([
      server.prisma.visitLog.groupBy({
        by: ['dayKey'],
        where: { createdAt: range },
        _count: { id: true },
        orderBy: { dayKey: 'asc' },
      }),
      server.prisma.visitLog.groupBy({
        by: ['deviceId'],
        where: { createdAt: range },
      }),
      server.prisma.commerceProduct.findMany({
        where: { createdAt: range, status: 'PUBLISHED' },
        select: { createdAt: true },
      }),
      server.prisma.user.findMany({
        where: { createdAt: range },
        select: { createdAt: true },
      }),
      server.prisma.commerceOrder.findMany({
        where: { createdAt: range, status: { in: [...PAID_ORDER_STATUSES] } },
        select: { createdAt: true, totalRevenue: true, refundAmount: true },
      }),
    ]);

    const daily = new Map<string, {
      date: string;
      visitors: number;
      products: number;
      registrations: number;
      paidOrders: number;
      revenueUzs: number;
    }>();
    const cursor = new Date(Date.UTC(
      startDate.getUTCFullYear(),
      startDate.getUTCMonth(),
      startDate.getUTCDate(),
    ));
    const lastDay = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate());
    while (cursor.getTime() <= lastDay) {
      const date = cursor.toISOString().slice(0, 10);
      daily.set(date, { date, visitors: 0, products: 0, registrations: 0, paidOrders: 0, revenueUzs: 0 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    for (const item of visitorsByDay) {
      const day = daily.get(item.dayKey);
      if (day) day.visitors = item._count.id;
    }
    for (const item of products) {
      const day = daily.get(item.createdAt.toISOString().slice(0, 10));
      if (day) day.products += 1;
    }
    for (const item of users) {
      const day = daily.get(item.createdAt.toISOString().slice(0, 10));
      if (day) day.registrations += 1;
    }
    let revenueUzs = 0;
    for (const order of paidOrders) {
      const netOrderRevenue = Math.max(0, asNumber(order.totalRevenue) - asNumber(order.refundAmount));
      const day = daily.get(order.createdAt.toISOString().slice(0, 10));
      if (day) {
        day.paidOrders += 1;
        day.revenueUzs += netOrderRevenue;
      }
      revenueUzs += netOrderRevenue;
    }

    return reply.send({
      from: startDate.toISOString().slice(0, 10),
      to: endDate.toISOString().slice(0, 10),
      summary: {
        totalVisitors: uniqueVisitors.length,
        totalProducts: products.length,
        totalPaidOrders: paidOrders.length,
        revenueUzs: Number(revenueUzs.toFixed(2)),
        totalUsers: users.length,
      },
      chartData: Array.from(daily.values()).map((item) => ({
        ...item,
        revenueUzs: Number(item.revenueUzs.toFixed(2)),
      })),
    });
  });

  server.get('/admin/export', { preHandler: [adminMiddleware] }, async (request, reply) => {
    const parsed = exportQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_EXPORT_QUERY' });
    const { startDate, endDate } = getDateRange(parsed.data);
    const range = { gte: startDate, lte: endDate };
    let headers: string[];
    let rows: string[][];

    if (parsed.data.type === 'visitors') {
      headers = ['Date', 'Unique visitors'];
      const visitors = await server.prisma.visitLog.groupBy({
        by: ['dayKey'],
        where: { createdAt: range },
        _count: { id: true },
        orderBy: { dayKey: 'asc' },
      });
      rows = visitors.map((item) => [item.dayKey, String(item._count.id)]);
    } else if (parsed.data.type === 'products') {
      headers = ['Product count', 'Date'];
      const products = await server.prisma.commerceProduct.findMany({
        where: { createdAt: range, status: 'PUBLISHED' },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
      rows = products.map((item) => ['1', item.createdAt.toISOString().slice(0, 10)]);
    } else if (parsed.data.type === 'orders') {
      headers = ['Date', 'Paid order revenue (UZS)'];
      const orders = await server.prisma.commerceOrder.findMany({
        where: { createdAt: range, status: { in: [...PAID_ORDER_STATUSES] } },
        select: { createdAt: true, totalRevenue: true, refundAmount: true },
        orderBy: { createdAt: 'asc' },
      });
      rows = orders.map((order) => [
        order.createdAt.toISOString().slice(0, 10),
        Math.max(0, asNumber(order.totalRevenue) - asNumber(order.refundAmount)).toFixed(2),
      ]);
    } else {
      headers = ['Date', 'Unique visitors', 'Published products', 'Paid orders', 'Revenue (UZS)', 'Registrations'];
      const [visitorsByDay, products, users, orders] = await Promise.all([
        server.prisma.visitLog.groupBy({
          by: ['dayKey'],
          where: { createdAt: range },
          _count: { id: true },
        }),
        server.prisma.commerceProduct.findMany({
          where: { createdAt: range, status: 'PUBLISHED' },
          select: { createdAt: true },
        }),
        server.prisma.user.findMany({ where: { createdAt: range }, select: { createdAt: true } }),
        server.prisma.commerceOrder.findMany({
          where: { createdAt: range, status: { in: [...PAID_ORDER_STATUSES] } },
          select: { createdAt: true, totalRevenue: true, refundAmount: true },
        }),
      ]);
      const byDate = new Map<string, string[]>();
      const add = (date: string, column: number, amount = 1) => {
        const values = byDate.get(date) ?? [date, '0', '0', '0', '0.00', '0'];
        values[column] = column === 4
          ? (Number(values[column]) + amount).toFixed(2)
          : String(Number(values[column]) + amount);
        byDate.set(date, values);
      };
      visitorsByDay.forEach((item) => add(item.dayKey, 1, item._count.id));
      products.forEach((item) => add(item.createdAt.toISOString().slice(0, 10), 2));
      orders.forEach((order) => add(
        order.createdAt.toISOString().slice(0, 10),
        4,
        Math.max(0, asNumber(order.totalRevenue) - asNumber(order.refundAmount)),
      ));
      orders.forEach((order) => add(order.createdAt.toISOString().slice(0, 10), 3));
      users.forEach((item) => add(item.createdAt.toISOString().slice(0, 10), 5));
      rows = Array.from(byDate.values()).sort((a, b) => a[0].localeCompare(b[0]));
    }

    const csv = [headers, ...rows].map((row) => row.join(',')).join('\n');
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header(
      'Content-Disposition',
      `attachment; filename="averon_analytics_${parsed.data.type}_${startDate.toISOString().slice(0, 10)}_${endDate.toISOString().slice(0, 10)}.csv"`,
    );
    return reply.send(`\uFEFF${csv}`);
  });

  server.get('/funnel', { preHandler: [adminMiddleware] }, async (request, reply) => {
    const parsed = dateRangeQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ code: 'INVALID_DATE_RANGE' });
    const { startDate, endDate } = getDateRange(parsed.data);
    const range = { gte: startDate, lte: endDate };
    const [visits, favorites, paidOrders] = await Promise.all([
      server.prisma.visitLog.count({ where: { createdAt: range } }),
      server.prisma.productFavorite.count({ where: { createdAt: range } }),
      server.prisma.commerceOrder.count({
        where: { createdAt: range, status: { in: [...PAID_ORDER_STATUSES] } },
      }),
    ]);
    return reply.send({
      visits,
      favorites,
      paidOrders,
      favoriteRate: visits > 0 ? favorites / visits : 0,
      orderRate: visits > 0 ? paidOrders / visits : 0,
    });
  });
};
