// apps/api/src/modules/admin/notifications.ts
// Управление системными уведомлениями для администраторов

import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { adminMiddleware } from '../../lib/adminMiddleware';

export const notificationsModule: FastifyPluginAsync = async (server) => {
  const preHandler = [adminMiddleware];

  /**
   * GET /admin/notifications — список последних уведомлений + счетчик непрочитанных
   */
  server.get('/', { preHandler }, async (request: FastifyRequest) => {
    const adminId = request.user.userId;

    const [items, unreadCount] = await Promise.all([
      server.prisma.adminNotification.findMany({
        where: {
          OR: [{ targetAdminId: null }, { targetAdminId: adminId }],
        },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      server.prisma.adminNotification.count({
        where: {
          OR: [{ targetAdminId: null }, { targetAdminId: adminId }],
          isRead: false,
        },
      }),
    ]);

    return {
      items,
      unreadCount,
    };
  });

  server.patch<{ Params: { id: string } }>('/:id/read', { preHandler }, async (request, reply) => {
    const { id } = request.params;
    const adminId = request.user.userId;
    const isSuperAdmin = request.user.role === 'ADMIN' || (request.user as any).adminRole === 'SUPER_ADMIN';

    const existing = await server.prisma.adminNotification.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ message: 'Notification not found' });
    }

    if (existing.targetAdminId && existing.targetAdminId !== adminId && !isSuperAdmin) {
      return reply.status(403).send({ message: 'Forbidden' });
    }

    const updated = await server.prisma.adminNotification.update({
      where: { id },
      data: { isRead: true },
    });

    return reply.send(updated);
  });

  /**
   * PATCH /admin/notifications/read-all — отметить все прочитанными
   */
  server.patch('/read-all', { preHandler }, async (request: FastifyRequest, reply: FastifyReply) => {
    const adminId = request.user.userId;

    await server.prisma.adminNotification.updateMany({
      where: {
        OR: [{ targetAdminId: null }, { targetAdminId: adminId }],
        isRead: false,
      },
      data: { isRead: true },
    });

    return reply.send({ ok: true });
  });
};
