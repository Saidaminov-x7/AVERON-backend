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
    reply.status(401).send({ message: 'Unauthorized' });
    return;
  }

  if (!await requireActiveAuthSession(request, reply)) return;
};
