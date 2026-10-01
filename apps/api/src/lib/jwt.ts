// apps/api/src/lib/jwt.ts

import jwt from 'jsonwebtoken';
import { config } from '../config';
import { User, AdminRole } from '@prisma/client';
import { FastifyRequest } from 'fastify';
import crypto from 'crypto';

export interface JwtPayload {
  userId: string;
  role: string;
  adminRole?: AdminRole | null;
  sessionId?: string;
}

export interface RefreshPayload {
  userId: string;
  sessionId?: string;
}

/**
 * Генерирует пару access + refresh токенов.
 * Access token подписывается JWT_SECRET (60 минут),
 * Refresh token подписывается REFRESH_SECRET (7 дней).
 */
export const generateTokens = (
  user: Pick<User, 'id' | 'role' | 'adminRole'>,
  request: FastifyRequest,
  requestedSessionId?: string,
) => {
  const sessionId = requestedSessionId || crypto.randomUUID();
  const accessToken = request.server.jwt.sign(
    {
      userId: user.id,
      role: user.role,
      adminRole: user.adminRole ?? null,
      sessionId,
    } satisfies JwtPayload,
    { expiresIn: '60m' },
  );

  // Refresh token — долгоживущий, отдельный секрет
  const refreshToken = signRefreshToken({ userId: user.id, sessionId });

  return { accessToken, refreshToken, sessionId };
};

/**
 * Подписывает refresh-токен с REFRESH_SECRET.
 */
export const signRefreshToken = (payload: RefreshPayload): string => {
  return jwt.sign(payload, config.REFRESH_SECRET, { expiresIn: '7d' });
};

/**
 * Верифицирует refresh-токен с REFRESH_SECRET.
 */
export const verifyRefreshToken = (token: string): RefreshPayload => {
  return jwt.verify(token, config.REFRESH_SECRET) as RefreshPayload;
};
