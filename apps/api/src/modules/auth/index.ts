// apps/api/src/modules/auth/index.ts

import { FastifyPluginAsync } from 'fastify';
import { config } from '../../config';
import { isSecureRequest } from '../../lib/secure-request';
import { isTrustedCookieOrigin, createCorsOriginAllowlist } from '../../lib/cors-origins';
import { registerHandler } from './register';
import { loginHandler } from './login';
import { verify2faHandler, resend2faHandler } from './verify-2fa';
import { refreshHandler } from './refresh';
import { logoutHandler } from './logout';
import { meHandler, updateCatalogCountryPreferenceHandler, updateBodyProfileHandler } from './me';
import { forgotPasswordHandler, resetPasswordHandler } from './forgot-password';
import { exportUserDataHandler } from './export';
import { authMiddleware } from '../../lib/authMiddleware';
import { requestPhoneOtp, verifyPhoneOtp } from './phone-otp';
import { listMySessions, revokeMySession, revokeOtherSessions } from './sessions';
import { requestPhonePasswordLogin, requestPhonePasswordReset, requestPhoneRegistration, verifyPhonePasswordLogin, verifyPhonePasswordReset, verifyPhoneRegistration } from './phone-password';
import { adminTotpModule } from './admin-totp';
import { telegramAuthModule } from './telegram';
import { createAuthRateLimitKey } from './rate-limit-key';

function authRateLimitKey(scope: string, request: import('fastify').FastifyRequest, fields: string[] = []) {
  const body = request.body && typeof request.body === 'object'
    ? request.body as Record<string, unknown>
    : {};
  return createAuthRateLimitKey(config.JWT_SECRET, scope, request.ip, fields.map((field) => body[field]));
}

const requireTrustedCookieOrigin = async (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
  const origin = request.headers.origin;
  if ((origin && !isTrustedCookieOrigin(origin, createCorsOriginAllowlist(config.CORS_ORIGINS)))
      || (!origin && Boolean(request.headers.cookie))) {
    return reply.status(403).send({ message: 'Untrusted request origin' });
  }
};

export const authModule: FastifyPluginAsync = async (server) => {
  server.addHook('onRequest', async (request, reply) => {
    if (config.NODE_ENV === 'production' && !isSecureRequest(
      request.protocol,
      request.headers['x-forwarded-proto'],
      config.RAILWAY_ENVIRONMENT_ID,
    )) {
      return reply.status(426).send({ message: 'HTTPS is required' });
    }
  });

  await server.register(adminTotpModule);
  await server.register(telegramAuthModule);
  server.post('/register/phone/request-code', { config: { rateLimit: { max: 3, timeWindow: '15 minutes' } } }, requestPhoneRegistration);
  server.post('/register/phone/verify-code', { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } }, verifyPhoneRegistration);
  server.post('/login/phone/request-code', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, requestPhonePasswordLogin);
  server.post('/login/phone/verify-code', { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } }, verifyPhonePasswordLogin);
  server.post('/password/phone/request-code', { config: { rateLimit: { max: 3, timeWindow: '15 minutes' } } }, requestPhonePasswordReset);
  server.post('/password/phone/verify-code', { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } }, verifyPhonePasswordReset);
  server.post('/phone/request-code', {
    config: { rateLimit: { max: 3, timeWindow: '10 minutes', keyGenerator: (req) => authRateLimitKey('phone-request-code', req, ['phone']) } },
  }, requestPhoneOtp);

  server.post('/phone/verify-code', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes', keyGenerator: (req) => authRateLimitKey('phone-verify-code', req, ['phone']) } },
  }, verifyPhoneOtp);

  // Запрос на сброс пароля (rate limit: 5 запросов за 15 минут с одного IP)
  server.post('/forgot-password', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '15 minutes',
        keyGenerator: (req) => authRateLimitKey('forgot-password', req, ['email']),
      },
    },
  }, forgotPasswordHandler);

  // Сброс пароля по токену
  server.post('/reset-password', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '15 minutes',
        keyGenerator: (req) => authRateLimitKey('reset-password', req, ['token']),
      },
    },
  }, resetPasswordHandler);

  // Регистрация нового пользователя
  server.post('/register', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '15 minutes',
        keyGenerator: (req) => authRateLimitKey('register', req, ['email', 'phone']),
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
        keyGenerator: (req) => authRateLimitKey('login', req, ['email']),
      },
    },
  }, loginHandler);

  // Верификация 2FA кода из Telegram
  server.post('/verify-2fa', {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '15 minutes',
        keyGenerator: (req) => authRateLimitKey('verify-2fa', req, ['tempToken']),
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
    preHandler: [requireTrustedCookieOrigin],
  }, refreshHandler);

  // Выход
  server.post('/logout', { preHandler: [requireTrustedCookieOrigin] }, logoutHandler);

  // Текущий пользователь (требует auth)
  server.get('/me', { preHandler: [authMiddleware] }, meHandler);
  server.patch('/me/catalog-country', { preHandler: [authMiddleware] }, updateCatalogCountryPreferenceHandler);
  server.patch('/me/body-profile', { preHandler: [authMiddleware] }, updateBodyProfileHandler);
  server.get('/sessions', { preHandler: [authMiddleware] }, listMySessions);
  server.delete<{ Params: { id: string } }>('/sessions/:id', { preHandler: [authMiddleware] }, revokeMySession);
  server.delete('/sessions', { preHandler: [authMiddleware] }, revokeOtherSessions);

  // GDPR: Экспорт персональных данных пользователя
  server.get('/me/export', { preHandler: [authMiddleware] }, exportUserDataHandler);
};
