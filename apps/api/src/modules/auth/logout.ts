// apps/api/src/modules/auth/logout.ts

import { FastifyReply, FastifyRequest } from 'fastify';
import { refreshCookieOptions } from '../../lib/cookies';
import { verifyRefreshToken } from '../../lib/jwt';

export const logoutHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const refreshToken =
    request.cookies?.refreshToken ||
    (request.body as { refreshToken?: string })?.refreshToken;

  if (refreshToken) {
    await request.server.redis.set(`bl:${refreshToken}`, '1', 'EX', 7 * 24 * 60 * 60);
    try {
      const decoded = verifyRefreshToken(refreshToken);
      if (decoded.sessionId) {
        await request.server.prisma.authSession.updateMany({
          where: { id: decoded.sessionId, userId: decoded.userId },
          data: { revokedAt: new Date() },
        });
      }
    } catch {}
  }

  const opts = refreshCookieOptions();
  reply.clearCookie('refreshToken', {
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
    path: opts.path,
  });

  return reply.send({ message: 'Logged out successfully' });
};
