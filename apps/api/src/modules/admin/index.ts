// apps/api/src/modules/admin/index.ts
// Главный файл модуля — регистрирует все admin-маршруты

import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { AdminRole } from '@prisma/client';
import FileType from 'file-type';
import { adminMiddleware, requireAdminRole } from '../../lib/adminMiddleware';
import { updateListingSchema } from '../listings/schemas';
import { AdminService } from './service';
import {
  adminListingsFilterSchema,
  adminUsersFilterSchema,
  rejectListingSchema,
  requestChangesSchema,
  blockUserSchema,
  changeRoleSchema,
  createPageSchema,
  updatePageSchema,
  updateSiteSettingsSchema,
  trafficFilterSchema,
} from './schemas';

export const adminModule: FastifyPluginAsync = async (server) => {
  // Все маршруты требуют роли ADMIN
  const preHandler = [adminMiddleware];
  // Роли для каждого типа действий
  const listingActionHandler = [requireAdminRole(AdminRole.SUPER_ADMIN, AdminRole.ADMIN, AdminRole.MODERATOR)];
  const userActionHandler = [requireAdminRole(AdminRole.SUPER_ADMIN, AdminRole.ADMIN)];
  const cmsHandler = [requireAdminRole(AdminRole.SUPER_ADMIN, AdminRole.ADMIN)];
  const settingsHandler = [requireAdminRole(AdminRole.SUPER_ADMIN)];
  const analyticsHandler = [requireAdminRole(AdminRole.SUPER_ADMIN, AdminRole.ADMIN)];
  const supportHandler = [requireAdminRole(AdminRole.SUPER_ADMIN, AdminRole.ADMIN, AdminRole.MODERATOR, AdminRole.SUPPORT)];

  // Сервис создаётся на каждый запрос (получает актуальный prisma instance)
  const getService = (req: FastifyRequest) => new AdminService(req.server.prisma);

  // ─── ОБЪЯВЛЕНИЯ ──────────────────────────────────────────────────────────────

  /**
   * GET /admin/listings — список всех объявлений с фильтрами
   */
  server.get('/listings', { preHandler: supportHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const filter = adminListingsFilterSchema.parse(request.query);
    const service = getService(request);
    return service.getListings(filter);
  });

  /**
   * PATCH /admin/listings/:id/approve — одобрить объявление
   */
  server.patch<{ Params: { id: string } }>('/listings/:id/approve', { preHandler: listingActionHandler }, async (request, reply) => {
    const service = getService(request);
    try {
      const result = await service.approveListing(request.params.id, request.user.userId, request.ip);
      return result;
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * PATCH /admin/listings/:id/reject — отклонить объявление (с причиной)
   */
  server.patch<{ Params: { id: string } }>('/listings/:id/reject', { preHandler: listingActionHandler }, async (request, reply) => {
    const dto = rejectListingSchema.parse(request.body);
    const service = getService(request);
    try {
      const result = await service.rejectListing(request.params.id, dto.reason, request.user.userId, request.ip);
      return result;
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * PATCH /admin/listings/:id/request-changes — запросить правки у автора
   */
  server.patch<{ Params: { id: string } }>('/listings/:id/request-changes', { preHandler: listingActionHandler }, async (request, reply) => {
    const dto = requestChangesSchema.parse(request.body);
    const service = getService(request);
    try {
      const result = await service.requestListingChanges(
        request.params.id,
        dto.comment,
        request.user.userId,
        request.ip,
      );
      return result;
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * PATCH /admin/listings/:id/verify — присвоить/снять статус 'Проверено Ijarauz'
   */
  server.patch<{ Params: { id: string }; Body: { isVerified?: boolean } }>('/listings/:id/verify', { preHandler: listingActionHandler }, async (request, reply) => {
    const service = getService(request);
    const isVerified = (request.body as { isVerified?: boolean })?.isVerified ?? true;
    try {
      const result = await service.verifyListing(request.params.id, isVerified, request.user.userId, request.ip);
      return result;
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * GET /admin/reports — список жалоб на объявления
   */
  server.get('/reports', { preHandler: listingActionHandler }, async (request: FastifyRequest) => {
    const { status, page = 1, limit = 20 } = request.query as { status?: 'OPEN' | 'RESOLVED' | 'DISMISSED'; page?: number; limit?: number };
    const service = getService(request);
    return service.getReports({ status, page: Number(page), limit: Number(limit) });
  });

  /**
   * PATCH /admin/reports/:id/status — обновить статус жалобы
   */
  server.patch<{ Params: { id: string }; Body: { status: 'OPEN' | 'RESOLVED' | 'DISMISSED' } }>('/reports/:id/status', { preHandler: listingActionHandler }, async (request, reply) => {
    const { status } = request.body;
    const service = getService(request);
    try {
      const result = await service.updateReportStatus(request.params.id, status, request.user.userId, request.ip);
      return result;
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

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
      const headers = ['ID', 'Имя', 'Email', 'Телефон', 'Роль', 'Объявлений', 'Статус', 'Дата регистрации'];
      const rows = users.map((u) => [u.id, u.name, u.email, u.phone, u.role, u._count.listings, u.isBlocked ? 'Заблокирован' : 'Активен', u.createdAt.toISOString()]);
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

  // ─── СТАТИСТИКА ───────────────────────────────────────────────────────────────

  /**
   * GET /admin/stats/overview — метрики дашборда
   */
  server.get('/stats/overview', { preHandler: analyticsHandler }, async (request: FastifyRequest) => {
    const service = getService(request);
    return service.getOverviewStats();
  });

  /**
   * GET /admin/stats/traffic?days=30 — посещаемость по дням
   */
  server.get('/stats/traffic', { preHandler: analyticsHandler }, async (request: FastifyRequest) => {
    const { days } = trafficFilterSchema.parse(request.query);
    const service = getService(request);
    return service.getTrafficStats(days);
  });

  /**
   * GET /admin/stats/listings-by-city — объявления по городам
   */
  server.get('/stats/listings-by-city', { preHandler: analyticsHandler }, async (request: FastifyRequest) => {
    const service = getService(request);
    return service.getListingsByCity();
  });

  /**
   * GET /admin/stats/activity-feed — лента последних действий
   */
  server.get('/stats/activity-feed', { preHandler: analyticsHandler }, async (request: FastifyRequest) => {
    const service = getService(request);
    return service.getActivityFeed(20);
  });

  /**
   * GET /admin/stats/top-listings — топ объявлений по просмотрам
   */
  server.get('/stats/top-listings', { preHandler: analyticsHandler }, async (request: FastifyRequest) => {
    const service = getService(request);
    return service.getTopListings();
  });

  /**
   * GET /admin/stats/recent-complaints — последние жалобы на объявления
   */
  server.get('/stats/recent-complaints', { preHandler: analyticsHandler }, async (request: FastifyRequest) => {
    const service = getService(request);
    return service.getRecentComplaints();
  });

  /**
   * GET /admin/stats/moderation — конверсия модерации (одобрено/отклонено/pending)
   */
  server.get('/stats/moderation', { preHandler: analyticsHandler }, async (request: FastifyRequest) => {
    const service = getService(request);
    return service.getModerationStats();
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
    const data = await request.file({
      limits: { fileSize: 10 * 1024 * 1024 },
    });
    if (!data) {
      return reply.status(400).send({ message: 'No file uploaded' });
    }

    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);

    const detected = await FileType.fromBuffer(buffer);
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

          const headers = ['Дата', 'Посетители', 'Регистрации', 'Объявления'];
          const rows = filteredStats.map(s => [
            s.date,
            s.visitors,
            s.registrations,
            s.listings,
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

        case 'listings': {
          // Реестр объявлений за период
          const listings = await service.prisma.listing.findMany({
            where: {
              createdAt: {
                gte: dateFrom,
                lte: dateTo,
              },
            },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              title: true,
              city: true,
              price: true,
              status: true,
              moderationStatus: true,
              createdAt: true,
            },
          });

          const headers = ['ID', 'Название', 'Город', 'Цена', 'Статус', 'Модерация', 'Дата создания'];
          const rows = listings.map(l => [
            l.id,
            l.title,
            l.city,
            l.price,
            l.status,
            l.moderationStatus,
            l.createdAt.toISOString(),
          ]);

          const escapeCsv = (value: unknown) => {
            const text = String(value ?? '');
            return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
          };
          csvData = [headers, ...rows].map(r => r.map(escapeCsv).join(',')).join('\n');
          filename = `listings-report-${from}-${to}.csv`;
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

  // ─── [ФИЧА 2, 1, 8] FRAUD SCORE, DUPLICATE & FAIR PRICE ─────────────────────
  server.get<{ Params: { id: string } }>('/listings/:id/fraud-analysis', { preHandler: supportHandler }, async (request, reply) => {
    const { FraudDetectionService } = await import('./fraudDetection.service');
    const detector = new FraudDetectionService(request.server.prisma);
    try {
      return await detector.analyzeListing(request.params.id);
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  // ─── [ФИЧА 6] HEATMAP ANALYTICS ─────────────────────────────────────────────
  server.get('/analytics/heatmap', { preHandler: analyticsHandler }, async (request, reply) => {
    const listings = await request.server.prisma.listing.findMany({
      where: { status: 'ACTIVE', moderationStatus: 'APPROVED' },
      select: {
        id: true,
        lat: true,
        lng: true,
        price: true,
        rooms: true,
        city: true,
        district: true,
        viewsCount: true,
      },
      take: 2000,
    });

    const districtStats: Record<string, { count: number; totalPrice: number; avgPrice: number; views: number; lat: number; lng: number }> = {};

    for (const l of listings) {
      if (!l.district) continue;
      const key = `${l.city}_${l.district}`;
      if (!districtStats[key]) {
        districtStats[key] = {
          count: 0,
          totalPrice: 0,
          avgPrice: 0,
          views: 0,
          lat: l.lat || 41.311081,
          lng: l.lng || 69.240562,
        };
      }
      districtStats[key].count++;
      districtStats[key].totalPrice += Number(l.price);
      districtStats[key].views += l.viewsCount || 0;
    }

    const districts = Object.entries(districtStats).map(([key, stat]) => {
      const [city, district] = key.split('_');
      return {
        city,
        district,
        count: stat.count,
        avgPrice: Math.round(stat.totalPrice / (stat.count || 1)),
        views: stat.views,
        lat: stat.lat,
        lng: stat.lng,
      };
    });

    return {
      points: listings.filter((l) => l.lat && l.lng).map((l) => ({
        id: l.id,
        lat: l.lat,
        lng: l.lng,
        weight: Number(l.price),
        views: l.viewsCount,
      })),
      districts,
    };
  });

  // ─── [ФИЧА 9] SEARCH QUERIES ANALYTICS ───────────────────────────────────────
  server.get('/analytics/search-queries', { preHandler: analyticsHandler }, async (request, reply) => {
    const [recentSearches, totalSearches, zeroResultsCount] = await Promise.all([
      request.server.prisma.searchQueryLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      request.server.prisma.searchQueryLog.count(),
      request.server.prisma.searchQueryLog.count({ where: { resultsCount: 0 } }),
    ]);

    return {
      recentSearches,
      stats: {
        totalSearches,
        zeroResultsCount,
        unmetDemandPercent: totalSearches > 0 ? Math.round((zeroResultsCount / totalSearches) * 100) : 0,
      },
    };
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

  // ─── [ФИЧА 20] REVENUE & FINANCIAL STATS ────────────────────────────────────
  server.get('/stats/revenue', { preHandler: analyticsHandler }, async (request, reply) => {
    const [paidPurchases, activePromotions] = await Promise.all([
      request.server.prisma.promotionPurchase.findMany({
        where: { status: 'PAID' },
        select: { amount: true, tier: true, createdAt: true },
      }),
      request.server.prisma.listing.findMany({
        where: { isPromoted: true },
        select: {
          id: true,
          title: true,
          promotionTier: true,
          promotedUntil: true,
          createdAt: true,
        },
      }),
    ]);

    // РЕАЛЬНАЯ выручка — по факту оплаченных PromotionPurchase
    const actualRevenue = paidPurchases.reduce((sum, p) => sum + Number(p.amount), 0);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const last30DaysRevenue = paidPurchases
      .filter((p) => p.createdAt >= thirtyDaysAgo)
      .reduce((sum, p) => sum + Number(p.amount), 0);

    // ОЦЕНОЧНАЯ потенциальная стоимость текущих активных промо-объявлений
    const tierPrices: Record<string, number> = {
      BASIC: 50000,
      TOP: 120000,
      URGENT: 90000,
    };

    const tierCounts: Record<string, number> = { BASIC: 0, TOP: 0, URGENT: 0 };
    let potentialValueOfActivePromotions = 0;

    for (const p of activePromotions) {
      const tier = p.promotionTier || 'BASIC';
      tierCounts[tier] = (tierCounts[tier] || 0) + 1;
      potentialValueOfActivePromotions += tierPrices[tier] || 50000;
    }

    return {
      actualRevenue,
      last30DaysRevenue,
      hasPaymentIntegration: paidPurchases.length > 0,
      activePromotionsCount: activePromotions.length,
      potentialValueOfActivePromotions,
      tierCounts,
      promotedListings: activePromotions.slice(0, 50),
    };
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

    return {
      status: dbStatus === 'UP' && redisStatus === 'UP' ? 'HEALTHY' : 'DEGRADED',
      uptimeSeconds: Math.floor(process.uptime()),
      database: { status: dbStatus, latencyMs: dbLatencyMs },
      redis: { status: redisStatus, latencyMs: redisLatencyMs },
      memory: {
        rssMb: Math.round(memoryUsage.rss / 1024 / 1024),
        heapUsedMb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(memoryUsage.heapTotal / 1024 / 1024),
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

  // ─── [ФИЧА 29] BACKUPS & SNAPSHOTS ──────────────────────────────────────────
  server.get('/system/backups', { preHandler: settingsHandler }, async (request, reply) => {
    const [listingsCount, usersCount, reportsCount, lastSnapshot] = await Promise.all([
      request.server.prisma.listing.count(),
      request.server.prisma.user.count(),
      request.server.prisma.listingReport.count(),
      request.server.prisma.backupSnapshot.findFirst({
        where: { status: 'COMPLETED' },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      lastAutomaticBackup: lastSnapshot?.createdAt ? lastSnapshot.createdAt.toISOString() : null,
      lastBackupType: lastSnapshot?.type ?? null,
      snapshotStats: {
        listings: listingsCount,
        users: usersCount,
        reports: reportsCount,
      },
    };
  });

  server.get('/system/backups/export-snapshot', { preHandler: settingsHandler }, async (request, reply) => {
    const [users, listings, settings, reportsCount] = await Promise.all([
      request.server.prisma.user.findMany({
        select: { id: true, name: true, email: true, phone: true, role: true, createdAt: true },
      }),
      request.server.prisma.listing.findMany({ take: 500 }),
      request.server.prisma.siteSettings.findFirst(),
      request.server.prisma.listingReport.count(),
    ]);

    const adminUserId = (request as any).user?.userId || null;

    await request.server.prisma.backupSnapshot.create({
      data: {
        triggeredBy: adminUserId,
        type: 'MANUAL',
        status: 'COMPLETED',
        recordCounts: {
          listings: listings.length,
          users: users.length,
          reports: reportsCount,
        },
      },
    });

    const snapshot = {
      timestamp: new Date().toISOString(),
      version: '1.0',
      data: { users, listings, settings },
    };

    reply.header('Content-Type', 'application/json');
    reply.header('Content-Disposition', `attachment; filename="ijarauz-snapshot-${Date.now()}.json"`);
    return reply.send(JSON.stringify(snapshot, null, 2));
  });

  // ─── [ФИЧА 30] KANBAN MODERATION BOARD ──────────────────────────────────────
  server.get('/moderation/kanban', { preHandler: listingActionHandler }, async (request, reply) => {
    const [pending, changesRequested, rejected, approved] = await Promise.all([
      request.server.prisma.listing.findMany({
        where: { moderationStatus: 'PENDING' },
        include: { owner: { select: { id: true, name: true, phone: true, email: true, verified: true } }, images: true },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      request.server.prisma.listing.findMany({
        where: { moderationStatus: 'CHANGES_REQUESTED' },
        include: { owner: { select: { id: true, name: true, phone: true, email: true, verified: true } }, images: true },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      request.server.prisma.listing.findMany({
        where: { moderationStatus: 'REJECTED' },
        include: { owner: { select: { id: true, name: true, phone: true, email: true, verified: true } }, images: true },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      request.server.prisma.listing.findMany({
        where: { moderationStatus: 'APPROVED', isVerified: true },
        include: { owner: { select: { id: true, name: true, phone: true, email: true, verified: true } }, images: true },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
    ]);

    return {
      PENDING: pending,
      CHANGES_REQUESTED: changesRequested,
      REJECTED: rejected,
      APPROVED_VERIFIED: approved,
    };
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

  // ─── [ФИЧА: МОДЕРАЦИЯ ОТЗЫВОВ] ──────────────────────────────────────────────
  server.get('/reviews/pending', { preHandler: supportHandler }, async (request, reply) => {
    return request.server.prisma.review.findMany({
      where: { status: 'PENDING' },
      include: {
        author: { select: { id: true, name: true, email: true, phone: true, avatar: true } },
        listing: { select: { id: true, title: true, city: true, price: true } },
        landlord: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  });

  server.patch<{ Params: { id: string }; Body: { status: 'APPROVED' | 'REJECTED' } }>(
    '/reviews/:id/status',
    { preHandler: listingActionHandler },
    async (request, reply) => {
      const { id } = request.params;
      const { status } = request.body;
      const adminId = (request as any).user?.userId || null;

      if (!['APPROVED', 'REJECTED'].includes(status)) {
        return reply.status(400).send({ message: 'Некорректный статус отзыва' });
      }

      const review = await request.server.prisma.review.update({
        where: { id },
        data: {
          status: status as any,
          moderatedAt: new Date(),
          moderatedBy: adminId,
        },
      });

      return reply.send(review);
    },
  );

  // ─── [ФИЧА: SOFT-DELETE И КОРЗИНА ВОССТАНОВЛЕНИЯ (30 ДНЕЙ)] ──────────────────
  server.get('/trash', { preHandler: supportHandler }, async (request, reply) => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [deletedListings, deletedUsers] = await Promise.all([
      request.server.prisma.listing.findMany({
        where: { isDeleted: true, deletedAt: { gte: thirtyDaysAgo } },
        include: { owner: { select: { id: true, name: true, email: true } } },
        orderBy: { deletedAt: 'desc' },
        take: 50,
      }),
      request.server.prisma.user.findMany({
        where: { isDeleted: true, deletedAt: { gte: thirtyDaysAgo } },
        select: { id: true, name: true, email: true, phone: true, role: true, deletedAt: true },
        orderBy: { deletedAt: 'desc' },
        take: 50,
      }),
    ]);

    return reply.send({ listings: deletedListings, users: deletedUsers });
  });

  server.post<{ Params: { id: string } }>('/listings/:id/restore', { preHandler: listingActionHandler }, async (request, reply) => {
    const { id } = request.params;
    const restored = await request.server.prisma.listing.update({
      where: { id },
      data: { isDeleted: false, deletedAt: null, status: 'DRAFT' },
    });
    return reply.send({ success: true, listing: restored });
  });

  server.post<{ Params: { id: string } }>('/users/:id/restore', { preHandler: userActionHandler }, async (request, reply) => {
    const { id } = request.params;
    const restored = await request.server.prisma.user.update({
      where: { id },
      data: { isDeleted: false, deletedAt: null },
    });
    return reply.send({ success: true, user: restored });
  });

  // ─── [ФИЧА: ПРОСМОТР ВСЕХ ЧАТОВ И ВСЕХ ОБЪЯВЛЕНИЙ ПОЛЬЗОВАТЕЛЯ ИЗ АДМИНКИ] ───
  server.get<{ Params: { id: string } }>('/users/:id/all-listings', { preHandler: userActionHandler }, async (request, reply) => {
    const { id } = request.params;
    const listings = await request.server.prisma.listing.findMany({
      where: { ownerId: id },
      orderBy: { createdAt: 'desc' },
      include: {
        images: { select: { url: true } },
      },
    });
    return reply.send({ listings });
  });

  server.get<{ Params: { id: string } }>('/users/:id/all-chats', { preHandler: userActionHandler }, async (request, reply) => {
    const { id } = request.params;
    const messages = await request.server.prisma.chatMessage.findMany({
      where: {
        OR: [{ senderId: id }, { recipientId: id }],
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        sender: { select: { id: true, name: true, email: true, phone: true, avatar: true } },
        recipient: { select: { id: true, name: true, email: true, phone: true, avatar: true } },
        listing: { select: { id: true, title: true, price: true, city: true } },
      },
    });
    const aiSessions = await request.server.prisma.aISession.findMany({
      where: { userId: id },
      orderBy: { updatedAt: 'desc' },
      include: { messages: { orderBy: { timestamp: 'asc' } } },
    });
    return reply.send({ messages, aiSessions });
  });

  // ─── [ФИЧА: AI-АНАЛИЗАТОР ЖАЛОБЫ И ИСТОРИИ ЧАТОВ] ───────────────────────────
  server.get<{ Params: { id: string } }>('/reports/:id/ai-analyze', { preHandler: listingActionHandler }, async (request, reply) => {
    const { id } = request.params;
    const report = await request.server.prisma.listingReport.findUnique({
      where: { id },
      include: {
        listing: {
          include: {
            owner: { select: { id: true, name: true, email: true, phone: true, createdAt: true, isBlocked: true } },
            images: { select: { url: true } },
          },
        },
        reporter: { select: { id: true, name: true, email: true, phone: true, createdAt: true } },
      },
    });

    if (!report) {
      return reply.status(404).send({ message: 'Жалоба не найдена' });
    }

    // Извлекаем переписку между заявителем и собственником объекта, если оба есть
    let chatHistory: any[] = [];
    if (report.reporterId && report.listing?.ownerId) {
      chatHistory = await request.server.prisma.chatMessage.findMany({
        where: {
          OR: [
            { senderId: report.reporterId, recipientId: report.listing.ownerId },
            { senderId: report.listing.ownerId, recipientId: report.reporterId },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: 50,
      });
    }

    // AI-анализ жалобы и диалогов
    const isScamReason = ['SCAM', 'WRONG_PRICE', 'WRONG_PHOTOS'].includes(report.reason);
    const messagesCount = chatHistory.length;
    const combinedChatText = chatHistory.map((m) => m.message.toLowerCase()).join(' ');

    const prepaymentKeywords = ['предоплат', 'залог на карту', 'переведи', 'карта', 'click', 'payme', 'avans', 'аванс', 'перевод', 'card'];
    const hasPrepaymentTalk = prepaymentKeywords.some((kw) => combinedChatText.includes(kw));

    let riskScore = 20;
    const flags: string[] = [];

    if (isScamReason) {
      riskScore += 35;
      flags.push(`Причина жалобы критическая: ${report.reason}`);
    }

    if (report.listing?.owner?.isBlocked) {
      riskScore += 30;
      flags.push('Автор объявления уже был ранее заблокирован');
    }

    if (hasPrepaymentTalk) {
      riskScore += 35;
      flags.push('Обнаружено требование предоплаты/перевода на карту в переписке');
    }

    if (report.comment && report.comment.length > 5) {
      flags.push(`Комментарий заявителя: "${report.comment}"`);
    }

    riskScore = Math.min(100, riskScore);

    const verdict = riskScore >= 70 ? 'HIGH_RISK_FRAUD' : riskScore >= 40 ? 'SUSPICIOUS' : 'LOW_RISK';
    const recommendation =
      verdict === 'HIGH_RISK_FRAUD'
        ? 'Рекомендуется немедленно заблокировать объявление и аккаунт собственника, так как обнаружены явные признаки скама/вымогательства предоплаты.'
        : verdict === 'SUSPICIOUS'
        ? 'Рекомендуется запросить подтверждающие документы на собственность или перепроверить фотографии.'
        : 'Критических нарушений в переписке не выявлено. Возможна ложная или неактуальная жалоба.';

    return reply.send({
      reportId: report.id,
      reason: report.reason,
      reporterComment: report.comment,
      riskScore,
      verdict,
      flags,
      recommendation,
      chatMessagesAnalyzed: messagesCount,
      chatHistory: chatHistory.map((m) => ({
        id: m.id,
        isFromOwner: m.senderId === report.listing?.ownerId,
        text: m.message,
        time: m.createdAt,
      })),
      listingSummary: {
        id: report.listing?.id,
        title: report.listing?.title,
        price: report.listing?.price,
        city: report.listing?.city,
        owner: report.listing?.owner,
        images: report.listing?.images?.map((img) => img.url) || [],
      },
    });
  });
};


