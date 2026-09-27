// apps/api/src/modules/admin/theme.ts
// Управление дизайн-токенами: тема сайта + тема панели администратора

import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAdminRole } from '../../lib/adminMiddleware';
import { AdminService } from './service';

const updateThemeSchema = z.object({
  primaryColor: z.string().regex(/^#([0-9A-F]{3}){1,2}$/i).optional(),
  secondaryColor: z.string().regex(/^#([0-9A-F]{3}){1,2}$/i).optional(),
  backgroundColor: z.string().regex(/^#([0-9A-F]{3}){1,2}$/i).optional(),
  textColor: z.string().regex(/^#([0-9A-F]{3}){1,2}$/i).optional(),
  borderRadius: z.string().optional(),
  fontFamily: z.string().optional(),
});

export const themeModule: FastifyPluginAsync = async (server) => {
  const getService = (req: FastifyRequest) => new AdminService(req.server.prisma);

  // ─── ТЕМА САЙТА ──────────────────────────────────────────────────────────────

  /**
   * GET /admin/theme — получить текущие дизайн-токены САЙТА
   */
  server.get('/theme', { preHandler: [requireAdminRole('SUPER_ADMIN')] }, async (request: FastifyRequest) => {
    const service = getService(request);
    return service.getThemeSettings();
  });

  /**
   * PATCH /admin/theme — обновить дизайн-токены САЙТА
   */
  server.patch('/theme', { preHandler: [requireAdminRole('SUPER_ADMIN')] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const dto = updateThemeSchema.parse(request.body);
    const service = getService(request);
    const settings = await service.updateThemeSettings(dto, request.user.userId, request.ip);
    // C2: Инвалидируем публичный Redis-кэш темы после обновления
    await request.server.redis.del('site:theme:public').catch(() => {});
    return settings;
  });

  // ─── ТЕМА ПАНЕЛИ АДМИНИСТРАТОРА ──────────────────────────────────────────────

  /**
   * GET /admin/admin-theme — получить текущие дизайн-токены ПАНЕЛИ АДМИНИСТРАТОРА
   * Только для SUPER_ADMIN, НЕ публичный эндпоинт
   */
  server.get('/admin-theme', { preHandler: [requireAdminRole('SUPER_ADMIN')] }, async (request: FastifyRequest) => {
    const service = getService(request);
    return service.getAdminThemeSettings();
  });

  /**
   * PATCH /admin/admin-theme — обновить дизайн-токены ПАНЕЛИ АДМИНИСТРАТОРА
   * Только для SUPER_ADMIN, НЕ публичный эндпоинт
   */
  server.patch('/admin-theme', { preHandler: [requireAdminRole('SUPER_ADMIN')] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = updateThemeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ message: 'Invalid theme data', errors: parsed.error.flatten() });
    }
    const service = getService(request);
    const settings = await service.updateAdminThemeSettings(parsed.data, request.user.userId, request.ip);
    return settings;
  });
};