import type { FastifyReply, FastifyRequest } from 'fastify';

/** Reject expired or revoked access tokens before protected route handlers run. */
export async function requireActiveAuthSession(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const userId = request.user.userId;
  const sessionId = request.user.sessionId;
  if (!userId || !sessionId) {
    reply.status(401).send({ message: 'Unauthorized' });
    return false;
  }

  const session = await request.server.prisma.authSession.findFirst({
    where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  if (!session) {
    reply.status(401).send({ message: 'Unauthorized' });
    return false;
  }
  return true;
}
