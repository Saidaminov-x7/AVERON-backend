// apps/api/src/modules/auth/index.ts

import { FastifyPluginAsync } from 'fastify';
import { registerHandler } from './register';
import { loginHandler } from './login';
import { verify2faHandler, resend2faHandler } from './verify-2fa';
import { refreshHandler } from './refresh';
import { logoutHandler } from './logout';
import { meHandler } from './me';
import { googleAuthHandler } from './google';
import { forgotPasswordHandler, resetPasswordHandler } from './forgot-password';
import { exportUserDataHandler } from './export';
import { authMiddleware } from '../../lib/authMiddleware';

export const authModule: FastifyPluginAsync = async (server) => {
  // Запрос на сброс пароля (rate limit: 5 запросов за 15 минут с одного IP)
  server.post('/forgot-password', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '15 minutes',
        keyGenerator: (req) => `${req.ip}:${(req.body as any)?.email || 'unknown'}`,
      },
    },
  }, forgotPasswordHandler);

  // Сброс пароля по токену
  server.post('/reset-password', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '15 minutes',
      },
    },
  }, resetPasswordHandler);

  // Регистрация нового пользователя
  server.post('/register', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '15 minutes',
        keyGenerator: (req) => `${req.ip}:${(req.body as any)?.email || (req.body as any)?.phone || 'unknown'}`,
      },
    },
  }, registerHandler);

  // Google OAuth — sign in or sign up with phone verification
  server.post('/google', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, googleAuthHandler);

  // Вход / получение токенов (защита от брутфорса: 20 попыток за 15 минут)
  server.post('/login', {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '15 minutes',
        keyGenerator: (req) => `${req.ip}:${(req.body as any)?.email || 'unknown'}`,
      },
    },
  }, loginHandler);

  // Верификация 2FA кода из Telegram
  server.post('/verify-2fa', {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '15 minutes',
        keyGenerator: (req) => `${req.ip}:${(req.body as any)?.tempToken || 'unknown'}`,
      },
    },
  }, verify2faHandler);

  // Повторная отправка 2FA кода в Telegram
  server.post('/resend-2fa', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, resend2faHandler);

  // Обновление токенов по refreshToken (лимит 30 запросов в минуту)
  server.post('/refresh', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, refreshHandler);

  // Выход
  server.post('/logout', logoutHandler);

  // Текущий пользователь (требует auth)
  server.get('/me', { preHandler: [authMiddleware] }, meHandler);

  // GDPR: Экспорт персональных данных пользователя
  server.get('/me/export', { preHandler: [authMiddleware] }, exportUserDataHandler);
};