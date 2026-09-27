// apps/api/src/modules/listings/index.ts

import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../../lib/authMiddleware';
import { createUserRateLimit } from '../../lib/userRateLimit';
import { ListingsService } from './service';
import {
  createListingSchema,
  updateListingSchema,
  listingsFilterSchema,
  promoteListingSchema,
  reportListingSchema,
  estimatePriceSchema,
  CreateListingDto,
  UpdateListingDto,
} from './schemas';

export const listingsModule: FastifyPluginAsync = async (server) => {
  const getService = (req: FastifyRequest) => new ListingsService(req.server.prisma, req.server.redis, req.log);

  // Rate-limiters по userId
  const createListingRateLimit = createUserRateLimit((req) => req.server.redis, {
    keyPrefix: 'listings:create',
    max: 10,
    windowSec: 3600, // 10 объявлений в час на пользователя
  });

  const favoriteRateLimit = createUserRateLimit((req) => req.server.redis, {
    keyPrefix: 'listings:favorite',
    max: 60,
    windowSec: 3600, // 60 действий в час
  });

  const reportRateLimit = createUserRateLimit((req) => req.server.redis, {
    keyPrefix: 'listings:report',
    max: 10,
    windowSec: 3600, // 10 жалоб в час
  });

  // ─── Публичные маршруты ───────────────────────────────────────────────

  /**
   * GET /listings — список с фильтрацией
   */
  server.get('/', async (request: FastifyRequest, _reply: FastifyReply) => {
    const filter = listingsFilterSchema.parse(request.query);
    const service = getService(request);
    return service.findMany(filter);
  });

  /**
   * POST /listings/estimate-price — статистическая/AI оценка справедливой стоимости
   */
  server.post('/estimate-price', async (request: FastifyRequest) => {
    const dto = estimatePriceSchema.parse(request.body);
    const service = getService(request);
    return service.estimateFairPrice(dto);
  });

  // ─── Защищённые маршруты для личного кабинета (регистрируются ДО /:id) ─

  /**
   * GET /listings/my — мои объявления (все статусы)
   */
  server.get('/my', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest, _reply: FastifyReply) => {
    const { page = 1, limit = 20 } = request.query as { page?: number; limit?: number };
    const service = getService(request);
    return service.findMyListings(request.user.userId, Number(page), Number(limit));
  });

  /**
   * GET /listings/favorites — избранные объявления
   */
  server.get('/favorites', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest, _reply: FastifyReply) => {
    const { page = 1, limit = 20 } = request.query as { page?: number; limit?: number };
    const service = getService(request);
    return service.getFavorites(request.user.userId, Number(page), Number(limit));
  });

  /**
   * GET /listings/:id/similar — похожие объявления в том же районе/цене
   */
  server.get<{ Params: { id: string } }>('/:id/similar', async (request, reply) => {
    const service = getService(request);
    try {
      return await service.getSimilar(request.params.id);
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * GET /listings/:id/price-history — история изменения цены
   */
  server.get<{ Params: { id: string } }>('/:id/price-history', async (request) => {
    const service = getService(request);
    return service.getPriceHistory(request.params.id);
  });

  /**
   * POST /listings/:id/report — отправить жалобу на объявление
   */
  server.post<{ Params: { id: string } }>('/:id/report', {
    preHandler: [authMiddleware, reportRateLimit],
  }, async (request, reply) => {
    const dto = reportListingSchema.parse(request.body);
    const service = getService(request);
    try {
      const reporterId = (request as any).user?.userId || null;
      const report = await service.createReport(
        request.params.id,
        reporterId,
        dto.reason,
        dto.comment,
      );
      return reply.status(201).send(report);
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * GET /listings/:id — детали объявления
   */
  server.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const service = getService(request);
    const listing = await service.findById(request.params.id, true);
    if (!listing) {
      return reply.status(404).send({ message: 'Listing not found' });
    }
    return listing;
  });

  // ─── Защищённые маршруты ──────────────────────────────────────────────

  /**
   * POST /listings — создать объявление
   */
  server.post<{ Body: CreateListingDto }>('/', {
    preHandler: [authMiddleware, createListingRateLimit],
  }, async (request, reply) => {
    const dto = createListingSchema.parse(request.body);
    const service = getService(request);
    const listing = await service.create(request.user.userId, dto);

    const { logUserActivity } = await import('../../lib/activityLogger');
    void logUserActivity(request.server.prisma, request.user.userId, 'LISTING_CREATED', request, {
      listingId: listing.id,
      title: listing.title,
    });

    return reply.status(201).send(listing);
  });

  /**
   * POST /listings/:id/promote — продвижение (Boost/VIP)
   */
  server.post<{ Params: { id: string } }>('/:id/promote', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const dto = promoteListingSchema.parse(request.body);
    const service = getService(request);
    try {
      const updated = await service.promote(
        request.params.id,
        request.user.userId,
        dto.tier,
        dto.days,
      );
      return updated;
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * PATCH /listings/:id — обновить объявление
   */
  server.patch<{ Params: { id: string }; Body: UpdateListingDto }>('/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const dto = updateListingSchema.parse(request.body);
    const service = getService(request);
    try {
      const listing = await service.update(request.params.id, request.user.userId, dto);
      return listing;
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * POST /listings/:id/publish — опубликовать (DRAFT → ACTIVE)
   */
  server.post<{ Params: { id: string } }>('/:id/publish', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const service = getService(request);
    try {
      const listing = await service.publish(request.params.id, request.user.userId);
      return listing;
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * DELETE /listings/:id — мягкое удаление
   */
  server.delete<{ Params: { id: string } }>('/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const service = getService(request);
    const isAdmin = request.user.role === 'ADMIN';
    try {
      await service.delete(request.params.id, request.user.userId, isAdmin);
      return reply.status(204).send();
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * POST /listings/:id/favorite — добавить/убрать из избранного
   */
  server.post<{ Params: { id: string } }>('/:id/favorite', {
    preHandler: [authMiddleware, favoriteRateLimit],
  }, async (request, _reply) => {
    const service = getService(request);
    const result = await service.toggleFavorite(request.user.userId, request.params.id);
    return result;
  });
};
