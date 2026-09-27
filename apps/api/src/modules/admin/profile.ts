// apps/api/src/modules/admin/profile.ts
// Управление профилем администратора: смена пароля, редактирование личных данных

import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { adminMiddleware } from '../../lib/adminMiddleware';
import { AdminService } from './service';

const updateProfileSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  phone: z.string().min(5).max(20).optional(),
});

const updatePasswordSchema = z.object({
  currentPassword: z.string().min(6),
  newPassword: z.string().min(6),
});

export const profileModule: FastifyPluginAsync = async (server) => {
  const getService = (req: FastifyRequest) => new AdminService(req.server.prisma);

  /**
   * PATCH /admin/profile — обновить личные данные
   */
  server.patch('/profile', { preHandler: [adminMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const dto = updateProfileSchema.parse(request.body);
    const service = getService(request);
    try {
      const updated = await service.updateUser(request.user.userId, dto, request.user.userId, request.ip);
      return updated;
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * PATCH /admin/profile/password — сменить пароль
   */
  server.patch('/profile/password', { preHandler: [adminMiddleware] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const dto = updatePasswordSchema.parse(request.body);
    const service = getService(request);
    try {
      await service.updateAdminPassword(
        request.user.userId,
        dto.currentPassword,
        dto.newPassword,
        request.ip,
      );
      return reply.send({ ok: true });
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });
};