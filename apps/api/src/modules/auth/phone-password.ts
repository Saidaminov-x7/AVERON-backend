import { FastifyReply, FastifyRequest } from 'fastify';
import argon2 from 'argon2';
import crypto from 'crypto';
import { z } from 'zod';
import { generateTokens } from '../../lib/jwt';
import { refreshCookieOptions } from '../../lib/cookies';
import { sendSms } from './phone-otp';
import { saveAuthSession } from './sessions';
import { passwordValidation } from './schemas';
import { uzbekPhoneSchema } from './phone';
import { clearLoginFailures, isLoginTemporarilyLocked, loginFailureKey, recordLoginFailure } from './login-throttle';

const phone = uzbekPhoneSchema;
const password = passwordValidation;
const registrationSchema = z.object({ name: z.string().min(2).max(100), phone, password });
const loginSchema = z.object({ phone, password: z.string().min(1).max(256) });
const verifySchema = z.object({ phone, code: z.string().regex(/^\d{6}$/) });
const resetSchema = verifySchema.extend({ password });
const pendingKey = (kind: 'register' | 'login' | 'reset', normalizedPhone: string) => `phone-password:${kind}:${normalizedPhone}`;

type Pending = { codeHash: string; attempts: number; userId?: string; name?: string; passwordHash?: string };
const hashCode = (code: string) => crypto.createHash('sha256').update(code).digest('hex');

async function issueCode(request: FastifyRequest, reply: FastifyReply, key: string, payload: Omit<Pending, 'codeHash' | 'attempts'>, action: string) {
  const normalizedPhone = key.slice(key.lastIndexOf(':') + 1);
  const cooldownKey = `phone-password-cooldown:${normalizedPhone}`;
  if (await request.server.redis.exists(cooldownKey)) {
    return reply.status(429).send({ message: 'Подождите перед повторным запросом кода.' });
  }
  const code = crypto.randomInt(100000, 1_000_000).toString();
  await request.server.redis.set(cooldownKey, '1', 'EX', 60);
  await request.server.redis.set(key, JSON.stringify({ ...payload, codeHash: hashCode(code), attempts: 0 }), 'EX', 300);
  const sent = await sendSms(normalizedPhone.replace(/\D/g, ''), code, action).catch(() => false);
  if (!sent && process.env.NODE_ENV === 'production') {
    await request.server.redis.del(key);
    await request.server.redis.del(cooldownKey);
    return reply.status(503).send({ message: 'SMS-сервис не настроен. Добавьте SMS_API_URL и SMS_API_TOKEN.' });
  }
  return reply.send({ ok: true, expiresIn: 300, ...(process.env.NODE_ENV !== 'production' ? { devCode: code } : {}) });
}

async function readVerified(request: FastifyRequest, reply: FastifyReply, key: string, code: string) {
  const raw = await request.server.redis.get(key);
  if (!raw) { reply.status(401).send({ message: 'Код истёк. Запросите новый.' }); return null; }
  const pending = JSON.parse(raw) as Pending;
  if (pending.attempts >= 5) { await request.server.redis.del(key); reply.status(429).send({ message: 'Слишком много попыток.' }); return null; }
  if (!crypto.timingSafeEqual(Buffer.from(hashCode(code)), Buffer.from(pending.codeHash))) {
    await request.server.redis.set(key, JSON.stringify({ ...pending, attempts: pending.attempts + 1 }), 'KEEPTTL');
    reply.status(401).send({ message: 'Неверный код.' }); return null;
  }
  await request.server.redis.del(key);
  return pending;
}

async function completeLogin(request: FastifyRequest, reply: FastifyReply, user: any) {
  const { accessToken, refreshToken, sessionId } = generateTokens(user, request);
  await Promise.all([
    saveAuthSession(request, user.id, sessionId, refreshToken),
    request.server.prisma.user.update({ where: { id: user.id }, data: { refreshTokenHash: await argon2.hash(refreshToken), lastLoginAt: new Date(), verified: true } }),
  ]);
  reply.setCookie('refreshToken', refreshToken, refreshCookieOptions());
  return reply.send({ accessToken, user: { id: user.id, phone: user.phone, name: user.name, avatar: user.avatar, role: user.role, adminRole: user.adminRole } });
}

export async function requestPhoneRegistration(request: FastifyRequest, reply: FastifyReply) {
  const data = registrationSchema.parse(request.body);
  if (await request.server.prisma.user.findUnique({ where: { phone: data.phone } })) return reply.status(409).send({ message: 'Этот номер уже зарегистрирован.' });
  return issueCode(request, reply, pendingKey('register', data.phone), { name: data.name, passwordHash: await argon2.hash(data.password) }, 'регистрации');
}

export async function verifyPhoneRegistration(request: FastifyRequest, reply: FastifyReply) {
  const data = verifySchema.parse(request.body);
  const pending = await readVerified(request, reply, pendingKey('register', data.phone), data.code);
  if (!pending) return;
  const digits = data.phone.replace(/\D/g, '');
  const user = await request.server.prisma.user.create({ data: { phone: data.phone, email: `phone-${digits}@users.averon.local`, name: pending.name!, passwordHash: pending.passwordHash!, verified: true } });
  return completeLogin(request, reply, user);
}

export async function requestPhonePasswordLogin(request: FastifyRequest, reply: FastifyReply) {
  const data = loginSchema.parse(request.body);
  const failureKey = loginFailureKey('phone', data.phone);
  if (await isLoginTemporarilyLocked(request.server.redis, failureKey)) {
    return reply.status(429).send({ message: 'Неверный номер телефона или пароль. Попробуйте позже.' });
  }
  const user = await request.server.prisma.user.findUnique({ where: { phone: data.phone } });
  if (!user || !(await argon2.verify(user.passwordHash, data.password)) || user.isBlocked || user.isDeleted) {
    await recordLoginFailure(request.server.redis, failureKey);
    return reply.status(401).send({ message: 'Неверный номер телефона или пароль.' });
  }
  await clearLoginFailures(request.server.redis, failureKey);
  if (user.adminTotpEnabled || user.role === 'ADMIN' || user.adminRole) return reply.status(401).send({ message: 'Неверный номер телефона или пароль.' });
  return issueCode(request, reply, pendingKey('login', data.phone), { userId: user.id }, 'входа');
}

export async function verifyPhonePasswordLogin(request: FastifyRequest, reply: FastifyReply) {
  const data = verifySchema.parse(request.body);
  const pending = await readVerified(request, reply, pendingKey('login', data.phone), data.code);
  if (!pending) return;
  const user = await request.server.prisma.user.findUnique({ where: { id: pending.userId! } });
  if (!user || user.isBlocked) return reply.status(403).send({ message: 'Вход недоступен.' });
  return completeLogin(request, reply, user);
}

export async function requestPhonePasswordReset(request: FastifyRequest, reply: FastifyReply) {
  const data = z.object({ phone }).parse(request.body);
  const user = await request.server.prisma.user.findUnique({ where: { phone: data.phone } });
  if (!user || user.isBlocked) return reply.send({ ok: true, expiresIn: 300 });
  return issueCode(request, reply, pendingKey('reset', data.phone), { userId: user.id }, 'восстановления пароля');
}

export async function verifyPhonePasswordReset(request: FastifyRequest, reply: FastifyReply) {
  const data = resetSchema.parse(request.body);
  const pending = await readVerified(request, reply, pendingKey('reset', data.phone), data.code);
  if (!pending) return;
  await request.server.prisma.$transaction([
    request.server.prisma.user.update({ where: { id: pending.userId! }, data: { passwordHash: await argon2.hash(data.password), refreshTokenHash: null } }),
    request.server.prisma.authSession.updateMany({ where: { userId: pending.userId!, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await request.server.prisma.auditLog.create({ data: { userId: pending.userId!, action: 'PASSWORD_RESET_BY_PHONE', resource: 'User', resourceId: pending.userId! } });
  return reply.send({ success: true });
}
