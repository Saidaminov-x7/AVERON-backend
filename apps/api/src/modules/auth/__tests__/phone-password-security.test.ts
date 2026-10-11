import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import argon2 from 'argon2';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { config } from '../../../config';

vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgresql://127.0.0.1:5432/test';
  process.env.REDIS_URL = 'redis://127.0.0.1:6379';
  process.env.JWT_SECRET = globalThis.crypto.randomUUID().replaceAll('-', '').repeat(2);
  process.env.REFRESH_SECRET = globalThis.crypto.randomUUID().replaceAll('-', '').repeat(2);
  process.env.NODE_ENV = 'test';
  process.env.FEATURE_SMS_VERIFICATION = 'true';
});

import { requestPhonePasswordLogin, requestPhoneRegistration, verifyPhonePasswordLogin, verifyPhoneRegistration } from '../phone-password';
import { smsProvider } from '../../integrations/sms-provider';

describe('phone password OTP security', () => {
  it('rejects a wrong SMS code then completes login with one controlled SMS and an auth session', async () => {
    const originalEnvironment = config.NODE_ENV;
    config.NODE_ENV = 'production';
    let smsMessage = '';
    const sendSms = vi.spyOn(smsProvider, 'send').mockImplementation(async (_phone, message) => {
      smsMessage = message;
      return true;
    });
    const user = {
      id: 'fixture-user',
      phone: '+998901234567',
      name: 'Fixture customer',
      passwordHash: await argon2.hash('local-only-test-password'),
      role: 'USER',
      adminRole: null,
      avatar: null,
      isBlocked: false,
      isDeleted: false,
    };
    let otpAttempts = 0;
    const redis = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => 'OK'),
      del: vi.fn(async () => 1),
      eval: vi.fn(async (_script: string, _keys: number, _key: string, codeHash: string) => {
        otpAttempts += 1;
        if (otpAttempts === 1) return [1];
        expect(codeHash).toBe(createHash('sha256').update(smsMessage.match(/\b\d{6}\b/)?.[0] ?? '').digest('hex'));
        return [3, JSON.stringify({ codeHash, attempts: 0, userId: user.id })];
      }),
    };
    const prisma = {
      user: {
        findUnique: vi.fn(async ({ where }: { where: { phone?: string; id?: string } }) =>
          (where.phone === user.phone || where.id === user.id) ? user : null),
        update: vi.fn(async () => user),
      },
      authSession: { upsert: vi.fn(async () => ({})) },
    };
    const app = Fastify();
    app.decorate('redis', redis as never);
    app.decorate('prisma', prisma as never);
    await app.register(cookie);
    await app.register(jwt, { secret: config.JWT_SECRET });
    app.post('/login/phone/request-code', requestPhonePasswordLogin);
    app.post('/login/phone/verify-code', verifyPhonePasswordLogin);
    await app.ready();

    try {
      const requested = await app.inject({
        method: 'POST',
        url: '/login/phone/request-code',
        payload: { phone: user.phone, password: 'local-only-test-password' },
      });
      expect(requested.statusCode).toBe(200);
      expect(requested.json()).not.toHaveProperty('devCode');
      expect(sendSms).toHaveBeenCalledOnce();
      expect(sendSms.mock.calls[0][0]).toBe('998901234567');
      const controlledCode = smsMessage.match(/\b(\d{6})\b/)?.[1];
      expect(controlledCode).toBeDefined();
      expect(requested.body).not.toContain(controlledCode);

      const invalid = await app.inject({
        method: 'POST',
        url: '/login/phone/verify-code',
        payload: { phone: user.phone, code: '000000' },
      });
      expect(invalid.statusCode).toBe(401);

      const verified = await app.inject({
        method: 'POST',
        url: '/login/phone/verify-code',
        payload: { phone: user.phone, code: controlledCode },
      });
      expect(verified.statusCode, verified.body).toBe(200);
      expect(verified.json()).toMatchObject({
        user: { id: user.id, phone: user.phone, role: 'USER' },
      });
      expect(verified.json().accessToken).toEqual(expect.any(String));
      expect(verified.headers['set-cookie']).toContain('refreshToken=');
      expect(prisma.user.update).toHaveBeenCalledOnce();
      expect(prisma.authSession.upsert).toHaveBeenCalledOnce();
    } finally {
      config.NODE_ENV = originalEnvironment;
      sendSms.mockRestore();
      await app.close();
    }
  });

  it('returns account-independent registration responses and atomically enforces per-phone resend cooldown', async () => {
    const activeCooldowns = new Set<string>();
    const redis = {
      set: vi.fn(async (key: string, ..._options: Array<string | number>) => {
        if (!key.includes(':cooldown:')) return 'OK';
        if (activeCooldowns.has(key)) return null;
        activeCooldowns.add(key);
        return 'OK';
      }),
      del: vi.fn(),
    };
    const user = {
      findUnique: vi.fn(),
      create: vi.fn(),
    };
    const app = Fastify();
    app.decorate('redis', redis as never);
    app.decorate('prisma', { user } as never);
    app.post('/register/phone/request-code', requestPhoneRegistration);
    await app.ready();
    const payload = {
      name: 'Buyer',
      phone: '+998 90 123 45 67',
      password: 'StrongPass123!',
    };

    try {
      const responses = await Promise.all([
        app.inject({ method: 'POST', url: '/register/phone/request-code', payload }),
        app.inject({ method: 'POST', url: '/register/phone/request-code', payload }),
      ]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 429]);
      expect(user.findUnique).not.toHaveBeenCalled();
      expect(redis.set.mock.calls[0]).toEqual([
        'averon:v1:auth:phone-password:cooldown:+998901234567',
        '1',
        'EX',
        60,
        'NX',
      ]);
      expect(redis.set).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });

  it('does not create a duplicate account after an already-registered phone verifies a code', async () => {
    const redis = {
      eval: vi.fn(async () => [
        3,
        JSON.stringify({ codeHash: 'a'.repeat(64), attempts: 0, name: 'Buyer', passwordHash: 'hashed' }),
      ]),
    };
    const user = {
      findUnique: vi.fn(async () => ({ id: 'existing-user', phone: '+998901234567' })),
      create: vi.fn(),
    };
    const app = Fastify();
    app.decorate('redis', redis as never);
    app.decorate('prisma', { user } as never);
    app.post('/register/phone/verify-code', verifyPhoneRegistration);
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/register/phone/verify-code',
        payload: { phone: '+998 90 123 45 67', code: '123456' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'PHONE_ALREADY_REGISTERED' });
      expect(user.create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
