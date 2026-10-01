// apps/api/src/modules/auth/index.ts

import { FastifyPluginAsync } from 'fastify';
import { config } from '../../config';
import { registerHandler } from './register';
import { loginHandler } from './login';
import { verify2faHandler, resend2faHandler } from './verify-2fa';
import { refreshHandler } from './refresh';
import { logoutHandler } from './logout';
import { meHandler } from './me';
import { forgotPasswordHandler, resetPasswordHandler } from './forgot-password';
import { exportUserDataHandler } from './export';
import { authMiddleware } from '../../lib/authMiddleware';
import { requestPhoneOtp, verifyPhoneOtp } from './phone-otp';
import { listMySessions, revokeMySession, revokeOtherSessions } from './sessions';
import { requestPhonePasswordLogin, requestPhonePasswordReset, requestPhoneRegistration, verifyPhonePasswordLogin, verifyPhonePasswordReset, verifyPhoneRegistration } from './phone-password';
import { adminTotpModule } from './admin-totp';

export const authModule: FastifyPluginAsync = async (server) => {
  server.addHook('onRequest', async (request, reply) => {
    if (config.NODE_ENV === 'production' && request.protocol !== 'https') {
      return reply.status(426).send({ message: 'HTTPS is required' });
    }
  });

  await server.register(adminTotpModule);
  server.post('/register/phone/request-code', { config: { rateLimit: { max: 3, timeWindow: '15 minutes' } } }, requestPhoneRegistration);
  server.post('/register/phone/verify-code', { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } }, verifyPhoneRegistration);
  server.post('/login/phone/request-code', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, requestPhonePasswordLogin);
  server.post('/login/phone/verify-code', { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } }, verifyPhonePasswordLogin);
  server.post('/password/phone/request-code', { config: { rateLimit: { max: 3, timeWindow: '15 minutes' } } }, requestPhonePasswordReset);
  server.post('/password/phone/verify-code', { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } }, verifyPhonePasswordReset);
  server.post('/phone/request-code', {
    config: { rateLimit: { max: 3, timeWindow: '10 minutes', keyGenerator: (req) => `${req.ip}:${(req.body as any)?.phone || 'unknown'}` } },
  }, requestPhoneOtp);

  server.post('/phone/verify-code', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes', keyGenerator: (req) => `${req.ip}:${(req.body as any)?.phone || 'unknown'}` } },
  }, verifyPhoneOtp);

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
  server.get('/sessions', { preHandler: [authMiddleware] }, listMySessions);
  server.delete<{ Params: { id: string } }>('/sessions/:id', { preHandler: [authMiddleware] }, revokeMySession);
  server.delete('/sessions', { preHandler: [authMiddleware] }, revokeOtherSessions);

  // GDPR: Экспорт персональных данных пользователя
  server.get('/me/export', { preHandler: [authMiddleware] }, exportUserDataHandler);
};
