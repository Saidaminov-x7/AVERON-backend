// apps/api/src/modules/analytics/index.ts
// Модуль аналитики и трекинга посещений

import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { adminMiddleware } from '../../lib/adminMiddleware';

const visitSchema = z.object({
  deviceId: z.string().min(8).max(128),
  path: z.string().min(1).max(512),
});

const dateRangeQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  days: z.coerce.number().min(1).max(365).optional().default(30),
});

export const analyticsModule: FastifyPluginAsync = async (server) => {
  /**
   * POST /analytics/visit — публичный неблокирующий эндпоинт фиксации визита
   */
  server.post('/visit', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { deviceId, path } = visitSchema.parse(request.body);

      // Игнорируем внутренние системные пути
      if (path.startsWith('/admin') || path.startsWith('/api') || path.startsWith('/_next')) {
        return reply.status(200).send({ ok: true, ignored: true });
      }

      const todayKey = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
      const ip = (request.headers['x-forwarded-for'] as string) || request.ip;
      const userAgent = request.headers['user-agent'] as string | undefined;

      // Дедупликация: одно устройство учитывается ровно 1 раз в сутки благодаря @@unique([deviceId, dayKey])
      await request.server.prisma.visitLog.upsert({
        where: {
          deviceId_dayKey: {
            deviceId,
            dayKey: todayKey,
          },
        },
        update: {
          path, // Обновляем последний посещенный путь за день
        },
        create: {
          deviceId,
          dayKey: todayKey,
          path,
          ip,
          userAgent,
        },
      });

      return reply.status(200).send({ ok: true });
    } catch {
      // Fire-and-forget — всегда возвращаем успешный ответ, чтобы не ломать фронтенд
      return reply.status(200).send({ ok: true });
    }
  });

  /**
   * GET /admin/stats/visitors — детальная статистика уникальных посетителей по дням за период
   */
  server.get('/admin/visitors', { preHandler: [adminMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { from, to, days } = dateRangeQuerySchema.parse(request.query);

    let startDate: Date;
    let endDate: Date;

    if (from && to) {
      startDate = new Date(`${from}T00:00:00.000Z`);
      endDate = new Date(`${to}T23:59:59.999Z`);
    } else {
      endDate = new Date();
      startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
    }

    // Группировка уникальных визитов по dayKey
    const visits = await request.server.prisma.visitLog.groupBy({
      by: ['dayKey'],
      where: {
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      _count: {
        id: true,
      },
      orderBy: {
        dayKey: 'asc',
      },
    });

    const totalVisitors = visits.reduce((acc, curr) => acc + curr._count.id, 0);

    return reply.send({
      from: startDate.toISOString().slice(0, 10),
      to: endDate.toISOString().slice(0, 10),
      totalVisitors,
      daily: visits.map((v) => ({
        date: v.dayKey,
        visitors: v._count.id,
      })),
    });
  });

  /**
   * GET /admin/stats/range — комплексная статистика за произвольный период
   */
  server.get('/admin/range', { preHandler: [adminMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { from, to, days } = dateRangeQuerySchema.parse(request.query);

    let startDate: Date;
    let endDate: Date;

    if (from && to) {
      startDate = new Date(`${from}T00:00:00.000Z`);
      endDate = new Date(`${to}T23:59:59.999Z`);
    } else {
      endDate = new Date();
      startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
    }

    const [visitorsGroup, listings, users, byCityRaw] = await Promise.all([
      // Посетители по дням
      request.server.prisma.visitLog.groupBy({
        by: ['dayKey'],
        where: { createdAt: { gte: startDate, lte: endDate } },
        _count: { id: true },
        orderBy: { dayKey: 'asc' },
      }),
      // Объявления за период
      request.server.prisma.listing.findMany({
        where: { createdAt: { gte: startDate, lte: endDate } },
        select: { createdAt: true, city: true },
      }),
      // Пользователи за период
      request.server.prisma.user.findMany({
        where: { createdAt: { gte: startDate, lte: endDate } },
        select: { createdAt: true },
      }),
      // Группировка по городам
      request.server.prisma.listing.groupBy({
        by: ['city'],
        where: {
          createdAt: { gte: startDate, lte: endDate },
          status: 'ACTIVE',
          moderationStatus: 'APPROVED',
        },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
      }),
    ]);

    // Карта по дням для сводного графика
    const dailyMap = new Map<string, { date: string; visitors: number; listings: number; registrations: number }>();

    // Инициализируем дни в диапазоне
    const cur = new Date(startDate);
    while (cur <= endDate) {
      const key = cur.toISOString().slice(0, 10);
      dailyMap.set(key, { date: key, visitors: 0, listings: 0, registrations: 0 });
      cur.setDate(cur.getDate() + 1);
    }

    visitorsGroup.forEach((v) => {
      const item = dailyMap.get(v.dayKey);
      if (item) item.visitors = v._count.id;
    });

    listings.forEach((l) => {
      const key = l.createdAt.toISOString().slice(0, 10);
      const item = dailyMap.get(key);
      if (item) item.listings += 1;
    });

    users.forEach((u) => {
      const key = u.createdAt.toISOString().slice(0, 10);
      const item = dailyMap.get(key);
      if (item) item.registrations += 1;
    });

    return reply.send({
      from: startDate.toISOString().slice(0, 10),
      to: endDate.toISOString().slice(0, 10),
      summary: {
        totalVisitors: visitorsGroup.reduce((a, b) => a + b._count.id, 0),
        totalListings: listings.length,
        totalUsers: users.length,
      },
      chartData: Array.from(dailyMap.values()),
      byCity: byCityRaw.map((c) => ({ city: c.city, count: c._count.id })),
    });
  });

  /**
   * GET /admin/stats/export — выгрузка отчётов в CSV
   */
  server.get('/admin/export', { preHandler: [adminMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { from, to, days } = dateRangeQuerySchema.parse(request.query);
    const { type = 'traffic' } = request.query as { type?: string };

    let startDate: Date;
    let endDate: Date;

    if (from && to) {
      startDate = new Date(`${from}T00:00:00.000Z`);
      endDate = new Date(`${to}T23:59:59.999Z`);
    } else {
      endDate = new Date();
      startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
    }

    let headers: string[] = [];
    let rows: string[][] = [];

    if (type === 'visitors') {
      headers = ['Дата', 'Уникальных посетителей'];
      const visits = await request.server.prisma.visitLog.groupBy({
        by: ['dayKey'],
        where: { createdAt: { gte: startDate, lte: endDate } },
        _count: { id: true },
        orderBy: { dayKey: 'asc' },
      });
      rows = visits.map((v) => [v.dayKey, String(v._count.id)]);
    } else if (type === 'listings') {
      headers = ['ID', 'Название', 'Город', 'Цена', 'Статус', 'Дата создания'];
      const listings = await request.server.prisma.listing.findMany({
        where: { createdAt: { gte: startDate, lte: endDate } },
        orderBy: { createdAt: 'desc' },
      });
      rows = listings.map((l) => [
        l.id,
        `"${l.title.replace(/"/g, '""')}"`,
        l.city,
        String(l.price),
        l.status,
        l.createdAt.toISOString().slice(0, 10),
      ]);
    } else {
      // Сводный трафик
      headers = ['Дата', 'Посетители', 'Регистрации', 'Новые объявления'];
      const [visitorsGroup, listings, users] = await Promise.all([
        request.server.prisma.visitLog.groupBy({
          by: ['dayKey'],
          where: { createdAt: { gte: startDate, lte: endDate } },
          _count: { id: true },
          orderBy: { dayKey: 'asc' },
        }),
        request.server.prisma.listing.findMany({
          where: { createdAt: { gte: startDate, lte: endDate } },
          select: { createdAt: true },
        }),
        request.server.prisma.user.findMany({
          where: { createdAt: { gte: startDate, lte: endDate } },
          select: { createdAt: true },
        }),
      ]);

      const map = new Map<string, { visitors: number; registrations: number; listings: number }>();
      const cur = new Date(startDate);
      while (cur <= endDate) {
        map.set(cur.toISOString().slice(0, 10), { visitors: 0, registrations: 0, listings: 0 });
        cur.setDate(cur.getDate() + 1);
      }

      visitorsGroup.forEach((v) => {
        const item = map.get(v.dayKey);
        if (item) item.visitors = v._count.id;
      });
      listings.forEach((l) => {
        const item = map.get(l.createdAt.toISOString().slice(0, 10));
        if (item) item.listings += 1;
      });
      users.forEach((u) => {
        const item = map.get(u.createdAt.toISOString().slice(0, 10));
        if (item) item.registrations += 1;
      });

      rows = Array.from(map.entries()).map(([date, d]) => [
        date,
        String(d.visitors),
        String(d.registrations),
        String(d.listings),
      ]);
    }

    const csv = [headers, ...rows].map((r) => r.join(',')).join('\n');

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="analytics_${type}_${startDate.toISOString().slice(0, 10)}_${endDate.toISOString().slice(0, 10)}.csv"`);
    return reply.send('\uFEFF' + csv);
  });

  /**
   * GET /analytics/funnel — Воронка конверсии (Визиты -> Избранное -> Заявки на просмотр)
   */
  server.get('/funnel', {
    preHandler: [adminMiddleware],
  }, async (request) => {
    const { from, to, days } = dateRangeQuerySchema.parse(request.query);
    const dateTo = to ? new Date(to) : new Date();
    const dateFrom = from ? new Date(from) : new Date(Date.now() - (days || 30) * 24 * 60 * 60 * 1000);

    const [views, favorites, viewingRequests] = await Promise.all([
      request.server.prisma.visitLog.count({ where: { createdAt: { gte: dateFrom, lte: dateTo } } }),
      request.server.prisma.favorite.count({ where: { createdAt: { gte: dateFrom, lte: dateTo } } }),
      request.server.prisma.viewingRequest.count({ where: { createdAt: { gte: dateFrom, lte: dateTo } } }),
    ]);

    return {
      views,
      favorites,
      viewingRequests,
      favoriteRate: views > 0 ? favorites / views : 0,
      viewingRate: favorites > 0 ? viewingRequests / favorites : 0,
      conversionRate: views > 0 ? viewingRequests / views : 0,
    };
  });
};
