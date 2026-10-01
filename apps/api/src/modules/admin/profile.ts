// apps/api/src/modules/admin/profile.ts
// Управление профилем администратора: смена пароля, редактирование личных данных

import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { adminMiddleware } from '../../lib/adminMiddleware';
import { AdminService } from './service';
import { passwordValidation } from '../auth/schemas';
import { uzbekPhoneSchema } from '../auth/phone';

const updateProfileSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  phone: uzbekPhoneSchema.optional(),
  telegramId: z.string().trim().regex(/^\d{5,20}$/, 'Telegram ID должен содержать 5–20 цифр').optional().or(z.literal('')),
  avatar: z.string().url().nullable().optional(),
});

const updatePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordValidation,
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