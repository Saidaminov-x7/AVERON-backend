// apps/api/src/modules/auth/refresh.ts

import { FastifyReply, FastifyRequest } from 'fastify';
import argon2 from 'argon2';
import { generateTokens, verifyRefreshToken } from '../../lib/jwt';
import { refreshCookieOptions } from '../../lib/cookies';
import { saveAuthSession } from './sessions';

export const refreshHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const refreshToken = request.cookies?.refreshToken;

  if (!refreshToken) {
    return reply.status(401).send({ message: 'No refresh token provided' });
  }

  try {
    const decoded = verifyRefreshToken(refreshToken);
    if (!decoded?.userId) {
      return reply.status(401).send({ message: 'Invalid refresh token' });
    }

    const isBlacklisted = await request.server.redis.get(`bl:${refreshToken}`);
    if (isBlacklisted) {
      return reply.status(401).send({ message: 'Token has been revoked' });
    }

    const user = await request.server.prisma.user.findUnique({
      where: { id: decoded.userId },
    });
    if (!user) {
      return reply.status(401).send({ message: 'User not found' });
    }

    if (user.isBlocked) {
      return reply.status(403).send({ message: 'User account is blocked' });
    }

    const session = decoded.sessionId ? await request.server.prisma.authSession.findFirst({
      where: { id: decoded.sessionId, userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    }) : null;

    // Existing cookies remain valid during rollout; every new login uses the
    // per-device session record and no longer logs other devices out.
    const expectedHash = session?.refreshTokenHash || user.refreshTokenHash;
    if (expectedHash) {
      const isCurrentToken = await argon2.verify(expectedHash, refreshToken);
      if (!isCurrentToken) {
        request.log.warn({ userId: user.id }, 'Refresh token does not match stored hash');
        return reply.status(401).send({ message: 'Invalid refresh token' });
      }
    }

    const { accessToken, refreshToken: newRefreshToken, sessionId } = generateTokens(user, request, decoded.sessionId);

    await request.server.redis.set(`bl:${refreshToken}`, '1', 'EX', 7 * 24 * 60 * 60);

    const newRefreshTokenHash = await argon2.hash(newRefreshToken);
    await request.server.prisma.user.update({
      where: { id: user.id },
      data: { refreshTokenHash: newRefreshTokenHash, lastLoginAt: user.lastLoginAt },
    });
    await saveAuthSession(request, user.id, sessionId, newRefreshToken);

    reply.setCookie('refreshToken', newRefreshToken, refreshCookieOptions());

    return reply.send({ accessToken });
  } catch {
    return reply.status(401).send({ message: 'Invalid or expired refresh token' });
  }
};
