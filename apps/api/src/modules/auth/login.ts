import { FastifyReply, FastifyRequest } from 'fastify';
import argon2 from 'argon2';
import crypto from 'crypto';
import { LoginDto, loginSchema } from './schemas';
import { AuthService } from './service';
import { generateTokens } from '../../lib/jwt';
import { refreshCookieOptions } from '../../lib/cookies';
import { sendTelegram2FACode } from '../../lib/telegram';
import { saveAuthSession } from './sessions';

export const loginHandler = async (
  request: FastifyRequest<{ Body: LoginDto }>,
  reply: FastifyReply,
) => {
  try {
    const dto = loginSchema.parse(request.body);
    const authService = new AuthService(request.server.prisma);

    // Поиск пользователя
    const user = await authService.findByEmail(dto.email);
    if (!user) {
      return reply.status(401).send({ message: 'Неверный email или пароль' });
    }

    // Проверка пароля
    const isValid = await authService.verifyPassword(user.passwordHash, dto.password);
    if (!isValid) {
      return reply.status(401).send({ message: 'Неверный email или пароль' });
    }

    // Проверка блокировки
    if (user.isBlocked) {
      return reply.status(403).send({ message: 'Ваш аккаунт заблокирован' });
    }

    // Если включена глобальная 2FA или пользователь является SUPER_ADMIN
    let twoFactorAuthEnabled = false;
    try {
      const settings = await request.server.prisma.siteSettings.findUnique({
        where: { id: 'singleton' },
      });
      twoFactorAuthEnabled = settings?.twoFactorAuthEnabled === true;
    } catch (err) {
      request.log.warn({ err }, 'Failed to fetch siteSettings in loginHandler');
    }

    const require2FA =
      user.adminRole === 'SUPER_ADMIN' ||
      (twoFactorAuthEnabled && (user.role === 'ADMIN' || !!user.adminRole));

    if (require2FA) {
      // Генерируем 6-значный код
      const code = Math.floor(100000 + crypto.randomInt(900000)).toString();
      const tempToken = crypto.randomBytes(32).toString('hex');

      // Сохраняем код и userId во временное хранилище Redis на 5 минут (300 сек)
      if (request.server.redis) {
        try {
          await request.server.redis.set(
            `2fa:${tempToken}`,
            JSON.stringify({ userId: user.id, code, email: user.email }),
            'EX',
            300,
          );
        } catch (rErr) {
          request.log.error({ rErr }, 'Redis set failed for 2FA token');
        }
      }

      // Отправляем код в Telegram Bot
      let tgResult: { success: boolean; message?: string } = { success: false, message: '' };
      try {
        tgResult = await sendTelegram2FACode(
          request.server.redis,
          code,
          user.email,
          request.ip,
        );
      } catch (tgErr) {
        request.log.error({ tgErr }, 'sendTelegram2FACode failed');
      }

      return reply.send({
        require2fa: true,
        tempToken,
        message: tgResult.success
          ? 'Код подтверждения отправлен в Telegram бот.'
          : 'Код сгенерирован. ' + (tgResult.message || 'Проверьте Telegram бот.'),
      });
    }

    // Для пользователей — стандартная генерация токенов
    const { accessToken, refreshToken, sessionId } = generateTokens(user, request);

    // Сохраняем хэш refreshToken и обновляем lastLoginAt
    try {
      const refreshTokenHash = await argon2.hash(refreshToken);
      await request.server.prisma.user.update({
        where: { id: user.id },
        data: {
          refreshTokenHash,
          lastLoginAt: new Date(),
        },
      });
      await saveAuthSession(request, user.id, sessionId, refreshToken);
    } catch (err) {
      request.log.error({ err }, 'Failed to hash and save refresh token or update lastLoginAt');
    }

    // Устанавливаем refreshToken в httpOnly cookie
    try {
      reply.setCookie('refreshToken', refreshToken, refreshCookieOptions());
    } catch (cookieErr) {
      request.log.warn({ cookieErr }, 'Failed to set refreshToken cookie');
    }

    try {
      const { logUserActivity } = await import('../../lib/activityLogger');
      void logUserActivity(request.server.prisma, user.id, 'LOGIN', request, {
        email: user.email,
      });
    } catch {}

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
  } catch (error: any) {
    request.log.error({ error }, 'Critical error in loginHandler');
    return reply.status(500).send({
      message: error?.message || 'Ошибка авторизации на сервере',
    });
  }
};
