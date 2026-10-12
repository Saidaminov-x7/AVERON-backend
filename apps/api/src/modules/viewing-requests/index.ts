// apps/api/src/modules/viewing-requests/index.ts

import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { authMiddleware } from '../../lib/authMiddleware';
import { createUserRateLimit } from '../../lib/userRateLimit';
import { createViewingRequestsService } from './service';
import { createViewingRequestSchema, updateViewingStatusSchema } from './schemas';
import { AdminRole, ViewingStatus } from '@prisma/client';

export const viewingRequestsModule: FastifyPluginAsync = async (server) => {
  const getService = (req: FastifyRequest) => createViewingRequestsService(req.server.prisma);
  const getCurrentAdminAccess = async (request: FastifyRequest) => {
    const user = await request.server.prisma.user.findUnique({
      where: { id: request.user.userId },
      select: { role: true, adminRole: true, isBlocked: true, isDeleted: true },
    });
    const isPrivilegedRole = user?.adminRole === AdminRole.SUPER_ADMIN ||
      user?.adminRole === AdminRole.ADMIN ||
      (user?.adminRole == null && user?.role === 'ADMIN');
    return {
      active: Boolean(user && !user.isBlocked && !user.isDeleted),
      isAdmin: Boolean(user && !user.isBlocked && !user.isDeleted && user.role === 'ADMIN' && isPrivilegedRole),
    };
  };

  const viewingRequestRateLimit = createUserRateLimit((req) => req.server.redis, {
    keyPrefix: 'viewing-requests:create',
    max: 15,
    windowSec: 3600, // 15 заявок в час
  });

  /**
   * POST /listings/:id/viewing-requests — подать заявку на просмотр
   */
  server.post<{ Params: { id: string } }>('/listings/:id/viewing-requests', {
    preHandler: [authMiddleware, viewingRequestRateLimit],
  }, async (request, reply) => {
    const dto = createViewingRequestSchema.parse(request.body);
    const service = getService(request);
    const result = await service.create(
      request.params.id,
      request.user.userId,
      dto.preferredDate,
      dto.message,
    );
    return reply.status(201).send(result);
  });

  /**
   * GET /viewing-requests — мои отправленные заявки на просмотр
   */
  server.get('/viewing-requests', {
    preHandler: [authMiddleware],
  }, async (request) => {
    const service = getService(request);
    return service.getUserRequests(request.user.userId);
  });

  /**
   * GET /admin/viewing-requests — заявки для владельца или админов
   */
  server.get('/admin/viewing-requests', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const access = await getCurrentAdminAccess(request);
    if (!access.active) return reply.status(403).send({ message: 'Access denied' });
    const service = getService(request);
    return service.getAdminOrOwnerRequests(request.user.userId, access.isAdmin);
  });

  /**
   * PATCH /viewing-requests/:id/status — изменить статус заявки
   */
  server.patch<{ Params: { id: string }; Body: { status: ViewingStatus } }>('/viewing-requests/:id/status', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const access = await getCurrentAdminAccess(request);
    if (!access.active) return reply.status(403).send({ message: 'Access denied' });
    const dto = updateViewingStatusSchema.parse(request.body);
    const service = getService(request);
    const updated = await service.updateStatus(request.params.id, request.user.userId, access.isAdmin, dto.status);
    return reply.send(updated);
  });
};
