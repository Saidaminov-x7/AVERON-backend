// apps/api/src/modules/saved-searches/index.ts

import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../../lib/authMiddleware';
import { createUserRateLimit } from '../../lib/userRateLimit';
import { SavedSearchesService } from './service';
import { createSavedSearchSchema, CreateSavedSearchDto } from './schemas';

export const savedSearchesModule: FastifyPluginAsync = async (server) => {
  const getService = (req: FastifyRequest) => new SavedSearchesService(req.server.prisma, req.log);

  const savedSearchRateLimit = createUserRateLimit((req) => req.server.redis, {
    keyPrefix: 'saved-searches:create',
    max: 20,
    windowSec: 3600,
  });

  /**
   * GET /saved-searches — список сохранённых поисков текущего пользователя
   */
  server.get('/', { preHandler: [authMiddleware] }, async (request: FastifyRequest) => {
    const service = getService(request);
    return service.findByUser(request.user.userId);
  });

  /**
   * POST /saved-searches — сохранить новый поиск
   */
  server.post<{ Body: CreateSavedSearchDto }>('/', {
    preHandler: [authMiddleware, savedSearchRateLimit],
  }, async (request, reply: FastifyReply) => {
    const dto = createSavedSearchSchema.parse(request.body);
    const service = getService(request);
    const result = await service.create(request.user.userId, dto);
    return reply.status(201).send(result);
  });

  /**
   * DELETE /saved-searches/:id — удалить сохранённый поиск
   */
  server.delete<{ Params: { id: string } }>('/:id', { preHandler: [authMiddleware] }, async (request, reply: FastifyReply) => {
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
};
