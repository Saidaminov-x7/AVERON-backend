// apps/api/src/lib/authMiddleware.ts

import { FastifyReply, FastifyRequest } from 'fastify';
import { requireActiveAuthSession } from './active-session';

/**
 * Prehandler middleware: проверяет JWT access-токен из заголовка Authorization
 * или из httpOnly cookie 'accessToken'.
 * Если токен невалиден — отвечает 401.
 */
export const authMiddleware = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  try {
    await request.jwtVerify();
  } catch {
    return reply.status(401).send({ message: 'Unauthorized' });
  }

  const userId = request.user.userId;
  if (!userId) return reply.status(401).send({ message: 'Unauthorized' });

  const user = await request.server.prisma.user.findUnique({
    where: { id: userId },
    select: { isBlocked: true, isDeleted: true },
  });

  if (!user || user.isBlocked || user.isDeleted) {
    return reply.status(403).send({ message: 'User account is blocked or unavailable' });
  }
};
