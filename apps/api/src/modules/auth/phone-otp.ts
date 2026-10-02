import { FastifyReply, FastifyRequest } from 'fastify';
import argon2 from 'argon2';
import crypto from 'crypto';
import { z } from 'zod';
import { config } from '../../config';
import { generateTokens } from '../../lib/jwt';
import { refreshCookieOptions } from '../../lib/cookies';
import { featureFlags } from '../features/feature-flags';
import { smsProvider } from '../integrations/sms-provider';
import { saveAuthSession } from './sessions';
import { consumeHashedOtp } from './otp-store';

const phoneSchema = z.string().trim().max(32).transform((value) => value.replace(/\D/g, '')).refine(
  (value) => /^998\d{9}$/.test(value),
  'Введите номер Узбекистана в формате +998 XX XXX XX XX',
);

const requestSchema = z.object({ phone: phoneSchema }).strict();
const verifySchema = z.object({ phone: phoneSchema, code: z.string().regex(/^\d{6}$/) }).strict();

const otpKey = (phone: string) => `averon:v1:auth:phone-otp:code:${phone}`;
const otpCooldownKey = (phone: string) => `averon:v1:auth:phone-otp:cooldown:${phone}`;
const RESEND_COOLDOWN_SECONDS = 60;

export async function sendSms(phone: string, code: string, action = 'входа') {
  return smsProvider.send(phone, `AVERON: код ${action} ${code}`);
}

function smsFeatureDisabled(reply: FastifyReply) {
  if (featureFlags.isEnabled('SMS_VERIFICATION')) return false;
  reply.status(403).send({ code: 'FEATURE_DISABLED', message: 'SMS verification is disabled.' });
  return true;
}

export async function requestPhoneOtp(
  request: FastifyRequest<{ Body: { phone: string } }>,
  reply: FastifyReply,
) {
  if (smsFeatureDisabled(reply)) return;
  const { phone } = requestSchema.parse(request.body);
  const cooldownKey = otpCooldownKey(phone);
  const cooldown = await request.server.redis.set(
    cooldownKey,
    '1',
    'EX',
    RESEND_COOLDOWN_SECONDS,
    'NX',
  );
  if (!cooldown) {
    return reply.status(429).send({ message: 'Подождите перед повторным запросом кода.' });
  }

  const code = crypto.randomInt(100000, 1_000_000).toString();
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  await request.server.redis.set(otpKey(phone), JSON.stringify({ codeHash, attempts: 0 }), 'EX', 300);

  let sent = config.NODE_ENV === 'test';
  if (config.NODE_ENV !== 'test') {
    sent = await sendSms(phone, code).catch((error) => {
      request.log.error({ errorName: error instanceof Error ? error.name : 'unknown' }, 'SMS provider request failed');
      return false;
    });
  }
  if (!sent) {
    await request.server.redis.del(otpKey(phone), cooldownKey);
    return reply.status(503).send({ code: 'SMS_PROVIDER_NOT_CONFIGURED', message: 'SMS verification is not configured.' });
  }

  return reply.send({
    ok: true,
    expiresIn: 300,
    ...(config.NODE_ENV === 'test' ? { devCode: code } : {}),
  });
}

export async function verifyPhoneOtp(
  request: FastifyRequest<{ Body: { phone: string; code: string } }>,
  reply: FastifyReply,
) {
  if (smsFeatureDisabled(reply)) return;
  const { phone, code } = verifySchema.parse(request.body);
  const key = otpKey(phone);
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  const { status: result } = await consumeHashedOtp(request.server.redis, key, codeHash);
  if (result === 0) return reply.status(401).send({ message: 'Код истёк. Запросите новый.' });
  if (result === 1) {
    return reply.status(401).send({ message: 'Неверный код.' });
  }
  if (result === 2) {
    return reply.status(429).send({ message: 'Слишком много попыток. Запросите новый код.' });
  }
  if (result !== 3) {
    request.log.error({ result }, 'Unexpected phone OTP verification result');
    return reply.status(503).send({ message: 'Не удалось проверить код. Запросите новый.' });
  }

  const normalizedPhone = `+${phone}`;
  let user = await request.server.prisma.user.findUnique({ where: { phone: normalizedPhone } });
  if (!user) {
    user = await request.server.prisma.user.create({
      data: {
        phone: normalizedPhone,
        email: `phone-${phone}@users.averon.local`,
        name: `Покупатель ${phone.slice(-4)}`,
        passwordHash: await argon2.hash(crypto.randomBytes(32).toString('hex')),
        verified: true,
      },
    });
  }
  if (user.isBlocked || user.isDeleted) return reply.status(403).send({ message: 'Вход недоступен.' });

  const { accessToken, refreshToken, sessionId } = generateTokens(user, request);
  await request.server.prisma.user.update({
    where: { id: user.id },
    data: { refreshTokenHash: await argon2.hash(refreshToken), lastLoginAt: new Date(), verified: true },
  });
  await saveAuthSession(request, user.id, sessionId, refreshToken);
  reply.setCookie('refreshToken', refreshToken, refreshCookieOptions());
  return reply.send({
    accessToken,
    user: { id: user.id, phone: user.phone, name: user.name, avatar: user.avatar, role: user.role, adminRole: user.adminRole },
  });
}
