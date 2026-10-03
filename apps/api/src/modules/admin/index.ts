// apps/api/src/modules/admin/index.ts
// Главный файл модуля — регистрирует все admin-маршруты

import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { AdminRole } from '@prisma/client';
import { fileTypeFromBuffer } from 'file-type';
import { adminMiddleware, requireAdminRole } from '../../lib/adminMiddleware';
import { readSingleMultipartFile } from '../../lib/singleMultipartFile';
import { AdminService } from './service';
import {
  adminUsersFilterSchema,
  blockUserSchema,
  changeRoleSchema,
  createPageSchema,
  updatePageSchema,
  updateSiteSettingsSchema,
} from './schemas';

export const adminModule: FastifyPluginAsync = async (server) => {
  // Все маршруты требуют роли ADMIN
  const preHandler = [adminMiddleware];
  // Роли для каждого типа действий
  const userActionHandler = [requireAdminRole(AdminRole.SUPER_ADMIN, AdminRole.ADMIN)];
  const cmsHandler = [requireAdminRole(AdminRole.SUPER_ADMIN, AdminRole.ADMIN)];
  const settingsHandler = [requireAdminRole(AdminRole.SUPER_ADMIN)];
  const analyticsHandler = [requireAdminRole(AdminRole.SUPER_ADMIN, AdminRole.ADMIN)];
  const supportHandler = [requireAdminRole(AdminRole.SUPER_ADMIN, AdminRole.ADMIN, AdminRole.MODERATOR, AdminRole.SUPPORT)];

  // Сервис создаётся на каждый запрос (получает актуальный prisma instance)
  const getService = (req: FastifyRequest) => new AdminService(req.server.prisma);

  /**
   * GET /admin/users — список пользователей с фильтрами
   */
  server.get('/users', { preHandler: userActionHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const filter = adminUsersFilterSchema.parse(request.query);
    const service = getService(request);
    try {
      const result = await service.getUsers(filter);
      return result;
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * GET /admin/users/export — экспорт пользователей в CSV
   */
  server.get('/users/export', { preHandler: userActionHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const filter = adminUsersFilterSchema.parse(request.query);
    const service = getService(request);
    const users = await service.exportUsers(filter);
    try {
      const headers = ['ID', 'Имя', 'Email', 'Телефон', 'Роль', 'Статус', 'Дата регистрации'];
      const rows = users.map((u) => [u.id, u.name, u.email, u.phone, u.role, u.isBlocked ? 'Заблокирован' : 'Активен', u.createdAt.toISOString()]);
      const escapeCsv = (value: unknown) => {
        const text = String(value ?? '');
        return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      };
      const csv = [headers, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n');
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', 'attachment; filename="users.csv"');
      return reply.send('\uFEFF' + csv);
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * GET /admin/users/:id — детальная карточка пользователя
   */
  server.get<{ Params: { id: string } }>('/users/:id', { preHandler }, async (request, reply) => {
    const service = getService(request);
    try {
      return await service.getUserById(request.params.id);
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * PATCH /admin/users/:id/block — заблокировать пользователя
   */
  server.patch<{ Params: { id: string } }>('/users/:id/block', { preHandler: userActionHandler }, async (request, reply) => {
    const dto = blockUserSchema.parse(request.body);
    const service = getService(request);
    try {
      return await service.blockUser(request.params.id, dto.reason, request.user.userId, request.ip);
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * PATCH /admin/users/:id/unblock — разблокировать пользователя
   */
  server.patch<{ Params: { id: string } }>('/users/:id/unblock', { preHandler: userActionHandler }, async (request, reply) => {
    const service = getService(request);
    try {
      return await service.unblockUser(request.params.id, request.user.userId, request.ip);
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * DELETE /admin/users/:id — удалить пользователя
   */
  server.delete<{ Params: { id: string } }>('/users/:id', { preHandler: settingsHandler }, async (request, reply) => {
    const { id } = request.params;
    const userToDelete = await request.server.prisma.user.findUnique({ where: { id } });
    if (!userToDelete) {
      return reply.status(404).send({ message: 'Пользователь не найден' });
    }
    if (userToDelete.email === 'vosilhojasaidaminov@gmail.com') {
      return reply.status(400).send({ message: 'Нельзя удалить главного супер-администратора' });
    }

    await request.server.prisma.user.delete({ where: { id } });
    return reply.send({ success: true, message: 'Пользователь удален' });
  });

  /**
   * GET /admin/users/:id/activity — логи активности конкретного пользователя
   */
  server.get<{ Params: { id: string }; Querystring: { page?: string; limit?: string; action?: string } }>(
    '/users/:id/activity',
    { preHandler: supportHandler },
    async (request, reply) => {
      const page = Math.max(1, parseInt(request.query.page || '1', 10));
      const limit = Math.min(100, Math.max(1, parseInt(request.query.limit || '50', 10)));
      const action = request.query.action;
      const where: any = { userId: request.params.id };
      if (action) where.action = action;

      const [items, total] = await request.server.prisma.$transaction([
        request.server.prisma.userActivityLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        request.server.prisma.userActivityLog.count({ where }),
      ]);

      return {
        items,
        meta: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit) || 1,
        },
      };
    },
  );

  server.get<{ Params: { id: string } }>('/users/:id/sessions', { preHandler: supportHandler }, async (request, reply) => {
    const items = await request.server.prisma.authSession.findMany({
      where: { userId: request.params.id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
      select: { id: true, userAgent: true, ipAddress: true, createdAt: true, lastSeenAt: true, expiresAt: true },
    });
    return reply.send(items);
  });

  server.delete<{ Params: { id: string; sessionId: string } }>('/users/:id/sessions/:sessionId', { preHandler: settingsHandler }, async (request, reply) => {
    const result = await request.server.prisma.authSession.updateMany({
      where: { id: request.params.sessionId, userId: request.params.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (!result.count) return reply.status(404).send({ message: 'Сессия не найдена' });
    return reply.send({ success: true });
  });

  // ─── АУДИТ-ЛОГИ ───────────────────────────────────────────────────────────────

  /**
   * GET /admin/audit-logs — логи действий пользователя
   */
  server.get('/audit-logs', { preHandler: analyticsHandler }, async (request: FastifyRequest) => {
    const { userId } = request.query as { userId?: string };
    const service = getService(request);
    return service.getAuditLogs(userId);
  });

  server.delete('/audit-logs', { preHandler: settingsHandler }, async (request, reply) => {
    const deleted = await request.server.prisma.auditLog.deleteMany({});
    return reply.send({ success: true, count: deleted.count });
  });

  // ─── СТРАНИЦЫ ────────────────────────────────────────────────────────────────

  /**
   * GET /admin/pages — список всех динамических страниц
   */
  server.get('/pages', { preHandler: cmsHandler }, async (request: FastifyRequest) => {
    const { page = 1, limit = 50 } = request.query as { page?: number; limit?: number };
    const service = getService(request);
    return service.getPages({ page: Number(page), limit: Number(limit) });
  });

  /**
   * GET /admin/pages/:id — одна страница
   */
  server.get<{ Params: { id: string } }>('/pages/:id', { preHandler: cmsHandler }, async (request, reply) => {
    const service = getService(request);
    try {
      return await service.getPageById(request.params.id);
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * POST /admin/pages — создать страницу
   */
  server.post('/pages', { preHandler: cmsHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const dto = createPageSchema.parse(request.body);
    const service = getService(request);
    try {
      const page = await service.createPage(dto, request.user.userId);
      return reply.status(201).send(page);
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * PATCH /admin/pages/:id — обновить страницу
   */
  server.patch<{ Params: { id: string } }>('/pages/:id', { preHandler: cmsHandler }, async (request, reply) => {
    const dto = updatePageSchema.parse(request.body);
    const service = getService(request);
    try {
      return await service.updatePage(request.params.id, dto, request.user.userId);
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * PATCH /admin/pages/:id/maintenance — переключить режим обслуживания страницы
   */
  server.patch<{ Params: { id: string } }>('/pages/:id/maintenance', { preHandler: settingsHandler }, async (request, reply) => {
    const service = getService(request);
    try {
      const page = await service.togglePageMaintenance(request.params.id, request.user.userId);
      return page;
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * DELETE /admin/pages/:id — удалить страницу
   */
  server.delete<{ Params: { id: string } }>('/pages/:id', { preHandler: cmsHandler }, async (request, reply) => {
    const service = getService(request);
    try {
      await service.deletePage(request.params.id, request.user.userId);
      return reply.status(204).send();
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  // ─── НАСТРОЙКИ САЙТА ─────────────────────────────────────────────────────────

  /**
   * GET /admin/site-settings — получить текущие настройки
   */
  server.get('/site-settings', { preHandler: settingsHandler }, async (request: FastifyRequest) => {
    const service = getService(request);
    return service.getSiteSettings();
  });

  /**
   * PATCH /admin/site-settings — обновить настройки
   */
  server.patch('/site-settings', { preHandler: settingsHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const dto = updateSiteSettingsSchema.parse(request.body);
      const service = getService(request);

      const settings = await service.updateSiteSettings(dto, request.user.userId, request.ip);

      // Инвалидируем Redis кэш публичных настроек
      try {
        await request.server.redis.del('site:settings:public');
      } catch (redisErr) {
        request.log.warn({ err: redisErr }, 'Failed to clear redis cache for site:settings:public');
      }

      return settings;
    } catch (err) {
      request.log.error({ err }, 'Error updating site settings');
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({
        message: error.message || 'Ошибка сохранения настроек сайта',
      });
    }
  });

  /**
   * POST /admin/site-settings/logo — загрузить логотип
   */
  server.post('/site-settings/logo', {
    preHandler: settingsHandler,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const data = await readSingleMultipartFile(request, 'file', 10 * 1024 * 1024);
    const buffer = data.data;

    const detected = await fileTypeFromBuffer(buffer);
    const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];
    let finalMime: string = detected?.mime || data.mimetype || 'image/png';
    if (!detected || !ALLOWED.includes(detected.mime)) {
      // Разрешаем также SVG если это валидный XML/SVG
      const isSvg = buffer.slice(0, 200).toString('utf-8').includes('<svg');
      if (!isSvg) {
        return reply.status(400).send({ message: 'INVALID_FILE_TYPE: Поддерживаются только изображения (JPEG, PNG, WEBP, GIF, SVG)' });
      }
      finalMime = 'image/svg+xml';
    }

    const service = getService(request);
    try {
      const result = await service.uploadSiteLogo(
        { filename: data.filename, mimetype: finalMime || data.mimetype, data: buffer },
        request.user.userId,
        request.ip,
      );
      await request.server.redis.del('site:settings:public').catch(() => {});
      return result;
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * DELETE /admin/site-settings/logo — удалить логотип
   */
  server.delete('/site-settings/logo', { preHandler: settingsHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const service = getService(request);
    try {
      const result = await service.deleteSiteLogo(request.user.userId, request.ip);
      await request.server.redis.del('site:settings:public').catch(() => {});
      return result;
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  // ─── ЭКСПОРТ АНАЛИТИКИ ──────────────────────────────────────────────────────

  /**
   * GET /admin/analytics/export — экспорт отчётов аналитики в CSV
   */
  server.get('/analytics/export', { preHandler: analyticsHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { type, from, to } = request.query as { type?: string; from?: string; to?: string };

    if (!type || !from || !to) {
      return reply.status(400).send({ message: 'Missing required parameters: type, from, to' });
    }

    const service = getService(request);
    const dateFrom = new Date(from);
    const dateTo = new Date(to);

    let csvData: string;
    let filename: string;

    try {
      switch (type) {
        case 'traffic': {
          // Посуточная статистика трафика
          const days = Math.ceil((dateTo.getTime() - dateFrom.getTime()) / (24 * 60 * 60 * 1000)) + 1;
          const trafficStats = await service.getTrafficStats(days);
          
          // Фильтруем по диапазону дат
          const filteredStats = trafficStats.filter(s => {
            const statDate = new Date(s.date);
            return statDate >= dateFrom && statDate <= dateTo;
          });

          const headers = ['Дата', 'Посетители', 'Регистрации', 'Новые товары'];
          const rows = filteredStats.map(s => [
            s.date,
            s.visitors,
            s.registrations,
            s.products,
          ]);

          const escapeCsv = (value: unknown) => {
            const text = String(value ?? '');
            return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
          };
          csvData = [headers, ...rows].map(r => r.map(escapeCsv).join(',')).join('\n');
          filename = `traffic-report-${from}-${to}.csv`;
          break;
        }

        case 'visitors': {
          // Журнал уникальных посетителей из VisitLog
          const visits = await service.prisma.visitLog.findMany({
            where: {
              createdAt: {
                gte: dateFrom,
                lte: dateTo,
              },
            },
            orderBy: { createdAt: 'desc' },
            take: 10000,
          });

          const headers = ['ID', 'Device ID', 'Day Key', 'IP Address', 'User Agent', 'Page', 'Created At'];
          const rows = visits.map(v => [
            v.id,
            v.deviceId,
            v.dayKey,
            v.ip,
            v.userAgent?.substring(0, 100) || '',
            v.path,
            v.createdAt.toISOString(),
          ]);

          const escapeCsv = (value: unknown) => {
            const text = String(value ?? '');
            return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
          };
          csvData = [headers, ...rows].map(r => r.map(escapeCsv).join(',')).join('\n');
          filename = `visitors-report-${from}-${to}.csv`;
          break;
        }

        default:
          return reply.status(400).send({ message: 'Invalid report type' });
      }

      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send('\uFEFF' + csvData); // BOM для корректного отображения кириллицы
    } catch (err) {
      const error = err as Error;
      return reply.status(500).send({ message: `Failed to generate export: ${error.message}` });
    }
  });

  // ─── [ФИЧА 18] PROMO CODES ──────────────────────────────────────────────────
  server.get('/promo-codes', { preHandler: settingsHandler }, async (request, reply) => {
    return request.server.prisma.promoCode.findMany({
      orderBy: { createdAt: 'desc' },
    });
  });

  server.post<{ Body: { code: string; discountPercent: number; maxUses: number; expiresAt?: string } }>(
    '/promo-codes',
    { preHandler: settingsHandler },
    async (request, reply) => {
      const { code, discountPercent, maxUses, expiresAt } = request.body;
      const created = await request.server.prisma.promoCode.create({
        data: {
          code: code.trim().toUpperCase(),
          discountPercent: discountPercent || 10,
          maxUses: maxUses || 100,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
        },
      });
      return reply.status(201).send(created);
    },
  );

  server.delete<{ Params: { id: string } }>('/promo-codes/:id', { preHandler: settingsHandler }, async (request, reply) => {
    await request.server.prisma.promoCode.delete({ where: { id: request.params.id } });
    return { success: true };
  });

  // ─── [ФИЧА 26] SYSTEM HEALTH MONITORING ─────────────────────────────────────
  server.get('/system/health', { preHandler: settingsHandler }, async (request, reply) => {
    let dbStatus = 'UP';
    let dbLatencyMs = 0;
    const startDb = Date.now();
    try {
      await request.server.prisma.$queryRaw`SELECT 1`;
      dbLatencyMs = Date.now() - startDb;
    } catch {
      dbStatus = 'DOWN';
    }

    let redisStatus = 'UP';
    let redisLatencyMs = 0;
    const startRedis = Date.now();
    try {
      await request.server.redis.ping();
      redisLatencyMs = Date.now() - startRedis;
    } catch {
      redisStatus = 'DOWN';
    }

    const memoryUsage = process.memoryUsage();
    const heapUsagePercent = memoryUsage.heapTotal > 0
      ? Math.round((memoryUsage.heapUsed / memoryUsage.heapTotal) * 100)
      : 0;

    return {
      status: dbStatus === 'UP' && redisStatus === 'UP' ? 'HEALTHY' : 'DEGRADED',
      backend: { status: 'UP', latencyMs: Date.now() - startDb },
      uptimeSeconds: Math.floor(process.uptime()),
      database: { status: dbStatus, latencyMs: dbLatencyMs },
      redis: { status: redisStatus, latencyMs: redisLatencyMs },
      memory: {
        rssMb: Math.round(memoryUsage.rss / 1024 / 1024),
        heapUsedMb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(memoryUsage.heapTotal / 1024 / 1024),
        heapUsagePercent,
      },
      nodeVersion: process.version,
      timestamp: new Date().toISOString(),
    };
  });

  // ─── [ФИЧА 27] WEBHOOKS ─────────────────────────────────────────────────────
  server.get('/webhooks', { preHandler: settingsHandler }, async (request, reply) => {
    return request.server.prisma.systemWebhook.findMany({ orderBy: { createdAt: 'desc' } });
  });

  server.post<{ Body: { name: string; url: string; events: string[]; secret?: string } }>(
    '/webhooks',
    { preHandler: settingsHandler },
    async (request, reply) => {
      const { name, url, events, secret } = request.body;
      const created = await request.server.prisma.systemWebhook.create({
        data: { name, url, events: events || ['ALL'], secret },
      });
      return reply.status(201).send(created);
    },
  );

  server.delete<{ Params: { id: string } }>('/webhooks/:id', { preHandler: settingsHandler }, async (request, reply) => {
    await request.server.prisma.systemWebhook.delete({ where: { id: request.params.id } });
    return { success: true };
  });

  server.post<{ Params: { id: string } }>('/webhooks/:id/test', { preHandler: settingsHandler }, async (request, reply) => {
    const webhook = await request.server.prisma.systemWebhook.findUnique({ where: { id: request.params.id } });
    if (!webhook) {
      return reply.status(404).send({ message: 'Вебхук не найден' });
    }

    const { sendWebhookRequest } = await import('../../lib/webhookDelivery');
    const testPayload = {
      event: 'SYSTEM_TEST_PING',
      timestamp: new Date().toISOString(),
      data: {
        message: 'Тестовое уведомление из панели управления Ijarauz',
        adminUserId: (request as any).user?.userId,
      },
    };

    const delivery = await request.server.prisma.webhookDelivery.create({
      data: {
        webhookId: webhook.id,
        event: 'SYSTEM_TEST_PING',
        payload: testPayload,
        attempts: 1,
        status: 'PENDING',
      },
    });

    const res = await sendWebhookRequest(webhook.url, testPayload, webhook.secret);

    await request.server.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: res.success ? 'SUCCESS' : 'FAILED',
        responseCode: res.statusCode || null,
        lastError: res.error || null,
      },
    });

    return reply.send({
      success: res.success,
      statusCode: res.statusCode,
      error: res.error,
      deliveryId: delivery.id,
    });
  });

  // ─── [ФИЧА: ГЛОБАЛЬНЫЙ ПОИСК] ───────────────────────────────────────────────
  server.get('/search/quick', { preHandler: supportHandler }, async (request, reply) => {
    const { q, type } = request.query as { q?: string; type?: 'products' | 'users' };
    if (!q || q.trim().length < 2) return [];
    const query = q.trim();

    if (type === 'products') {
      const products = await request.server.prisma.commerceProduct.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 100,
        select: { id: true, translations: true, salePriceUzs: true, status: true, slug: true },
      });
      const needle = query.toLocaleLowerCase();
      return products.flatMap((product) => {
        const translations = (product.translations || {}) as Record<string, { title?: string } | string>;
        const titles = Object.values(translations).map((value) => typeof value === 'string' ? value : value?.title || '');
        const title = titles.find(Boolean) || product.slug;
        if (![product.id, product.slug, ...titles].some((value) => value.toLocaleLowerCase().includes(needle))) return [];
        return [{ id: product.id, title, price: Number(product.salePriceUzs), status: product.status }];
      }).slice(0, 6);
    }

    if (type === 'users') {
      return request.server.prisma.user.findMany({
        where: {
          OR: [
            { id: { contains: query, mode: 'insensitive' } },
            { name: { contains: query, mode: 'insensitive' } },
            { email: { contains: query, mode: 'insensitive' } },
            { phone: { contains: query, mode: 'insensitive' } },
          ],
        },
        take: 6,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
        },
      });
    }

    return [];
  });

  server.post<{ Params: { id: string } }>('/users/:id/restore', { preHandler: userActionHandler }, async (request, reply) => {
    const { id } = request.params;
    const restored = await request.server.prisma.user.update({
      where: { id },
      data: { isDeleted: false, deletedAt: null },
    });
    return reply.send({ success: true, user: restored });
  });

  server.get<{ Params: { id: string } }>('/users/:id/ai-sessions', { preHandler: userActionHandler }, async (request, reply) => {
    const { id } = request.params;
    const aiSessions = await request.server.prisma.aISession.findMany({
      where: { userId: id },
      orderBy: { updatedAt: 'desc' },
      include: { messages: { orderBy: { timestamp: 'asc' } } },
    });
    return reply.send({ aiSessions });
  });

};
