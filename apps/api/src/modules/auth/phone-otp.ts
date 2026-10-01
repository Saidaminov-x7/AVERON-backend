import { FastifyReply, FastifyRequest } from 'fastify';
import argon2 from 'argon2';
import crypto from 'crypto';
import { z } from 'zod';
import { generateTokens } from '../../lib/jwt';
import { refreshCookieOptions } from '../../lib/cookies';
import { saveAuthSession } from './sessions';

const phoneSchema = z.string().transform((value) => value.replace(/\D/g, '')).refine(
  (value) => /^998\d{9}$/.test(value),
  'Введите номер Узбекистана в формате +998 XX XXX XX XX',
);

const requestSchema = z.object({ phone: phoneSchema });
const verifySchema = z.object({ phone: phoneSchema, code: z.string().regex(/^\d{6}$/) });

const otpKey = (phone: string) => `phone-otp:${phone}`;
const otpCooldownKey = (phone: string) => `phone-otp-cooldown:${phone}`;
const RESEND_COOLDOWN_SECONDS = 60;

export async function sendSms(phone: string, code: string, action = 'входа') {
  const endpoint = process.env.SMS_API_URL?.trim();
  const token = process.env.SMS_API_TOKEN?.trim();
  const sender = process.env.SMS_SENDER?.trim() || 'AVERON';
  if (!endpoint || !token) return false;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ mobile_phone: phone, message: `AVERON: код ${action} ${code}`, from: sender }),
    signal: AbortSignal.timeout(10_000),
  });
  return response.ok;
}

export async function requestPhoneOtp(
  request: FastifyRequest<{ Body: { phone: string } }>,
  reply: FastifyReply,
) {
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

  const sent = await sendSms(phone, code).catch((error) => {
    request.log.error({ error }, 'SMS provider request failed');
    return false;
  });
  if (!sent && process.env.NODE_ENV === 'production') {
    await request.server.redis.del(otpKey(phone), cooldownKey);
    return reply.status(503).send({ message: 'SMS-сервис ещё не подключён. Добавьте SMS_API_URL и SMS_API_TOKEN.' });
  }

  return reply.send({
    ok: true,
    expiresIn: 300,
    ...(process.env.NODE_ENV !== 'production' ? { devCode: code } : {}),
  });
}

export async function verifyPhoneOtp(
  request: FastifyRequest<{ Body: { phone: string; code: string } }>,
  reply: FastifyReply,
) {
  const { phone, code } = verifySchema.parse(request.body);
  const key = otpKey(phone);
  const stored = await request.server.redis.get(key);
  if (!stored) return reply.status(401).send({ message: 'Код истёк. Запросите новый.' });

  const payload = JSON.parse(stored) as { codeHash: string; attempts: number };
  if (payload.attempts >= 5) {
    await request.server.redis.del(key);
    return reply.status(429).send({ message: 'Слишком много попыток. Запросите новый код.' });
  }
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  if (!/^[a-f\d]{64}$/i.test(payload.codeHash) ||
      !crypto.timingSafeEqual(Buffer.from(codeHash, 'hex'), Buffer.from(payload.codeHash, 'hex'))) {
    await request.server.redis.set(key, JSON.stringify({ ...payload, attempts: payload.attempts + 1 }), 'KEEPTTL');
    return reply.status(401).send({ message: 'Неверный код.' });
  }
  await request.server.redis.del(key);

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
