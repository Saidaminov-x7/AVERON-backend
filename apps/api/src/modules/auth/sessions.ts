import { FastifyReply, FastifyRequest } from 'fastify';
import argon2 from 'argon2';
import { authMiddleware } from '../../lib/authMiddleware';

const sevenDaysFromNow = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

export async function saveAuthSession(
  request: FastifyRequest,
  userId: string,
  sessionId: string,
  refreshToken: string,
) {
  const refreshTokenHash = await argon2.hash(refreshToken);
  await request.server.prisma.authSession.upsert({
    where: { id: sessionId },
    create: {
      id: sessionId,
      userId,
      refreshTokenHash,
      userAgent: request.headers['user-agent']?.slice(0, 500),
      ipAddress: request.ip,
      expiresAt: sevenDaysFromNow(),
    },
    update: {
      refreshTokenHash,
      lastSeenAt: new Date(),
      expiresAt: sevenDaysFromNow(),
      revokedAt: null,
    },
  });
}

export async function listMySessions(request: FastifyRequest, reply: FastifyReply) {
  const currentSessionId = request.user.sessionId;
  const sessions = await request.server.prisma.authSession.findMany({
    where: { userId: request.user.userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: 'desc' },
    select: { id: true, userAgent: true, ipAddress: true, createdAt: true, lastSeenAt: true, expiresAt: true },
  });
  return reply.send(sessions.map((session) => ({ ...session, current: session.id === currentSessionId })));
}

export async function revokeMySession(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  const result = await request.server.prisma.authSession.updateMany({
    where: { id: request.params.id, userId: request.user.userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (!result.count) return reply.status(404).send({ message: 'Сессия не найдена' });
  return reply.send({ success: true, current: request.params.id === request.user.sessionId });
}

export async function revokeOtherSessions(request: FastifyRequest, reply: FastifyReply) {
  const result = await request.server.prisma.authSession.updateMany({
    where: { userId: request.user.userId, revokedAt: null, id: { not: request.user.sessionId || '' } },
    data: { revokedAt: new Date() },
  });
  return reply.send({ success: true, count: result.count });
}

export const sessionRoutes = { authMiddleware };
