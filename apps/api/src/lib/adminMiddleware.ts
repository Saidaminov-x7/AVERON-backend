// apps/api/src/lib/adminMiddleware.ts

import { FastifyReply, FastifyRequest } from 'fastify';
import { AdminRole } from '@prisma/client';

/**
 * Prehandler middleware: проверяет JWT-токен И наличие доступа к админ-панели (роль ADMIN или наличие adminRole).
 * Если токен невалиден — 401, если нет прав администрирования — 403.
 */
export const adminMiddleware = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  try {
    await request.jwtVerify();
  } catch {
    return reply.status(401).send({ message: 'Unauthorized' });
  }

  // Проверяем пользователя в БД для актуальной роли и проверки блокировки
  const user = await request.server.prisma.user.findUnique({
    where: { id: request.user.userId },
    select: { id: true, role: true, adminRole: true, isBlocked: true, isDeleted: true },
  });

  if (!user || user.isBlocked || user.isDeleted) {
    return reply.status(403).send({ message: 'Access denied. Account is blocked or does not exist.' });
  }

  // Разрешаем доступ, если роль ADMIN или назначен любой adminRole
  const hasAdminAccess = user.role === 'ADMIN' || !!user.adminRole;
  if (!hasAdminAccess) {
    return reply.status(403).send({ message: 'Access denied. Admin role required.' });
  }

  // Прикрепляем актуальные данные к request
  request.user.role = user.role;
  request.user.adminRole = user.adminRole ?? (user.role === 'ADMIN' ? AdminRole.SUPER_ADMIN : null);
};

/**
 * Фабрика middleware для проверки конкретных ролей административной панели
 * @param allowedRoles Список разрешенных ролей (SUPER_ADMIN, ADMIN, MODERATOR, SUPPORT)
 */
export const requireAdminRole = (...allowedRoles: AdminRole[]) => {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Сначала запускаем базовую проверку админа
    await adminMiddleware(request, reply);
    if (reply.sent) return;

    const userAdminRole = request.user.adminRole as AdminRole | null;

    if (!userAdminRole || !allowedRoles.includes(userAdminRole)) {
      return reply.status(403).send({
        message: 'Access denied. You do not have sufficient permissions for this operation.',
        requiredRoles: allowedRoles,
      });
    }
  };
};
