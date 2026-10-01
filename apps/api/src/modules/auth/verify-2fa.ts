// apps/api/src/modules/auth/verify-2fa.ts
// Эндпоинт верификации 2FA кода из Telegram

import { FastifyReply, FastifyRequest } from 'fastify';
import argon2 from 'argon2';
import crypto from 'crypto';
import { Verify2faDto, verify2faSchema, Resend2faDto, resend2faSchema } from './schemas';
import { generateTokens } from '../../lib/jwt';
import { refreshCookieOptions } from '../../lib/cookies';
import { sendTelegram2FACode } from '../../lib/telegram';
import { saveAuthSession } from './sessions';

export const verify2faHandler = async (
  request: FastifyRequest<{ Body: Verify2faDto }>,
  reply: FastifyReply,
) => {
  const dto = verify2faSchema.parse(request.body);
  const redis = request.server.redis;

  const dataStr = await redis.get(`2fa:${dto.tempToken}`);
  if (!dataStr) {
    return reply.status(400).send({ message: 'Срок действия кода истек или токен недействителен. Повторите попытку входа.' });
  }

  let session: { userId: string; code: string; email: string; attempts?: number };
  try {
    session = JSON.parse(dataStr);
  } catch {
    return reply.status(400).send({ message: 'Неверные данные сессии 2FA' });
  }

  // Проверяем совпадение 6-значного кода с лимитом попыток (максимум 5 попыток)
  if (session.code !== dto.code.trim()) {
    const attempts = (session.attempts || 0) + 1;
    const maxAttempts = 5;

    if (attempts >= maxAttempts) {
      // Превышен лимит попыток — немедленно удаляем сессию
      await redis.del(`2fa:${dto.tempToken}`);
      return reply.status(400).send({
        message: 'Слишком много неверных попыток. Сессия аннулирована, пожалуйста, войдите заново.',
      });
    }

    // Сохраняем обновлённый счётчик с сохранением оставшегося TTL (или до 5 минут)
    session.attempts = attempts;
    const remainingTtl = await redis.ttl(`2fa:${dto.tempToken}`);
    const ttl = remainingTtl > 0 ? remainingTtl : 300;
    await redis.set(`2fa:${dto.tempToken}`, JSON.stringify(session), 'EX', ttl);

    const remainingAttempts = maxAttempts - attempts;
    return reply.status(400).send({
      message: `Неверный код подтверждения. Осталось попыток: ${remainingAttempts}`,
    });
  }

  // Удаляем использованный 2FA токен из Redis
  await redis.del(`2fa:${dto.tempToken}`);

  // Находим пользователя в БД
  const user = await request.server.prisma.user.findUnique({
    where: { id: session.userId },
  });

  if (!user) {
    return reply.status(401).send({ message: 'Сессия подтверждения недействительна' });
  }

  if (user.isBlocked) {
    return reply.status(401).send({ message: 'Сессия подтверждения недействительна' });
  }

  // Генерируем токены доступа
  const { accessToken, refreshToken, sessionId } = generateTokens(user, request);

  // Сохраняем хэш refreshToken и обновляем lastLoginAt
  const refreshTokenHash = await argon2.hash(refreshToken);
  await request.server.prisma.user.update({
    where: { id: user.id },
    data: { refreshTokenHash, lastLoginAt: new Date() },
  });
  await saveAuthSession(request, user.id, sessionId, refreshToken);

  // Устанавливаем refreshToken в httpOnly cookie
  reply.setCookie('refreshToken', refreshToken, refreshCookieOptions());

  return reply.send({
    accessToken,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      role: user.role,
      adminRole: user.adminRole,
    },
  });
};

export const resend2faHandler = async (
  request: FastifyRequest<{ Body: Resend2faDto }>,
  reply: FastifyReply,
) => {
  const dto = resend2faSchema.parse(request.body);
  const redis = request.server.redis;

  const dataStr = await redis.get(`2fa:${dto.tempToken}`);
  if (!dataStr) {
    return reply.status(400).send({ message: 'Сессия истекла. Пожалуйста, начните вход заново.' });
  }

  let session: { userId: string; code: string; email: string };
  try {
    session = JSON.parse(dataStr);
  } catch {
    return reply.status(400).send({ message: 'Неверные данные сессии' });
  }

  // Генерируем новый 6-значный код
  const newCode = Math.floor(100000 + crypto.randomInt(900000)).toString();
  session.code = newCode;

  // Обновляем в Redis на еще 5 минут
  await redis.set(`2fa:${dto.tempToken}`, JSON.stringify(session), 'EX', 300);

  // Отправляем в Telegram
  const tgResult = await sendTelegram2FACode(
    redis,
    newCode,
    session.email,
    request.ip,
  );

  return reply.send({
    ok: true,
    message: tgResult.success ? 'Новый код отправлен в Telegram бот.' : (tgResult.message || 'Новый код сгенерирован.'),
  });
};
