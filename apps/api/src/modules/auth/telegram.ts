import argon2 from 'argon2';
import { createHash } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { config } from '../../config';
import { authMiddleware } from '../../lib/authMiddleware';
import { generateTokens } from '../../lib/jwt';
import { refreshCookieOptions } from '../../lib/cookies';
import { saveAuthSession } from './sessions';
import { verifyTelegramInitData } from './telegram-init-data';

const miniAppAuthSchema = z.object({ initData: z.string().min(1).max(4096) }).strict();
const linkSchema = miniAppAuthSchema;

function identityFromRequest(body: unknown) {
  const { initData } = miniAppAuthSchema.parse(body);
  const token = config.TELEGRAM_MINI_APP_BOT_TOKEN?.trim();
  if (!token) return { error: 'TELEGRAM_NOT_CONFIGURED' as const };
  const identity = verifyTelegramInitData(initData, token);
  return identity ? { identity, initData } : { error: 'INVALID_TELEGRAM_INIT_DATA' as const };
}

export const telegramAuthModule: FastifyPluginAsync = async (server) => {
  server.post('/telegram/mini-app/auth', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const result = identityFromRequest(request.body);
    if ('error' in result) {
      const status = result.error === 'TELEGRAM_NOT_CONFIGURED' ? 503 : 401;
      return reply.status(status).send({ code: result.error });
    }
    const user = await server.prisma.user.findUnique({
      where: { telegramId: result.identity.id },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        role: true,
        adminRole: true,
        isBlocked: true,
        isDeleted: true,
      },
    });
    if (!user) {
      return reply.send({
        linked: false,
        telegramUser: {
          id: result.identity.id,
          firstName: result.identity.firstName,
          ...(result.identity.lastName ? { lastName: result.identity.lastName } : {}),
          ...(result.identity.username ? { username: result.identity.username } : {}),
        },
      });
    }
    if (user.role !== Role.USER || user.adminRole || user.isBlocked || user.isDeleted) {
      return reply.status(403).send({ code: 'TELEGRAM_ACCOUNT_UNAVAILABLE' });
    }

    const replayKey = createHash('sha256').update(result.initData).digest('hex');
    const accepted = await server.redis.set(`telegram:mini-app:auth:${replayKey}`, '1', 'EX', 300, 'NX');
    if (accepted !== 'OK') return reply.status(409).send({ code: 'TELEGRAM_INIT_DATA_REPLAYED' });

    const { accessToken, refreshToken, sessionId } = generateTokens(user, request);
    const refreshTokenHash = await argon2.hash(refreshToken);
    await server.prisma.user.update({
      where: { id: user.id },
      data: { refreshTokenHash, lastLoginAt: new Date() },
    });
    await saveAuthSession(request, user.id, sessionId, refreshToken);
    reply.setCookie('refreshToken', refreshToken, refreshCookieOptions());
    return reply.send({
      linked: true,
      accessToken,
      user: { id: user.id, email: user.email, name: user.name, avatar: user.avatar, role: user.role, adminRole: null },
    });
  });

  server.post('/telegram/mini-app/link', {
    preHandler: [authMiddleware],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const result = identityFromRequest(request.body);
    if ('error' in result) {
      const status = result.error === 'TELEGRAM_NOT_CONFIGURED' ? 503 : 401;
      return reply.status(status).send({ code: result.error });
    }
    const user = await server.prisma.user.findUnique({
      where: { id: request.user.userId },
      select: { id: true, role: true, adminRole: true, telegramId: true, isBlocked: true, isDeleted: true },
    });
    if (!user || user.role !== Role.USER || user.adminRole || user.isBlocked || user.isDeleted) {
      return reply.status(403).send({ code: 'CUSTOMER_ACCOUNT_REQUIRED' });
    }
    if (user.telegramId === result.identity.id) return reply.send({ linked: true });
    if (user.telegramId) return reply.status(409).send({ code: 'TELEGRAM_ACCOUNT_ALREADY_LINKED' });

    try {
      const updated = await server.prisma.user.updateMany({
        where: {
          id: user.id,
          role: Role.USER,
          adminRole: null,
          telegramId: null,
          isBlocked: false,
          isDeleted: false,
        },
        data: { telegramId: result.identity.id },
      });
      if (updated.count !== 1) return reply.status(409).send({ code: 'TELEGRAM_ACCOUNT_ALREADY_LINKED' });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        return reply.status(409).send({ code: 'TELEGRAM_ID_ALREADY_LINKED' });
      }
      throw error;
    }

    await server.prisma.auditLog.create({
      data: {
        userId: user.id,
        action: 'TELEGRAM_ACCOUNT_LINKED',
        resource: 'User',
        resourceId: user.id,
        meta: { source: 'MINI_APP' },
      },
    });
    return reply.send({ linked: true });
  });
};
