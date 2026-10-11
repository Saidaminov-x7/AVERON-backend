import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyJwt from '@fastify/jwt';
import argon2 from 'argon2';
import crypto from 'crypto';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgresql://127.0.0.1:5432/test';
  process.env.REDIS_URL = 'redis://127.0.0.1:6379';
  process.env.JWT_SECRET = globalThis.crypto.randomUUID().replaceAll('-', '').repeat(2);
  process.env.REFRESH_SECRET = globalThis.crypto.randomUUID().replaceAll('-', '').repeat(2);
  process.env.NODE_ENV = 'test';
  process.env.FEATURE_SMS_VERIFICATION = 'true';
});

import {
  requestPhonePasswordLogin,
  requestPhoneRegistration,
  verifyPhonePasswordLogin,
  verifyPhoneRegistration,
} from '../phone-password';
import { config } from '../../../config';

describe('phone password OTP security', () => {
  it('completes registration through the real OTP handlers and creates a session without exposing a reusable code', async () => {
    const values = new Map<string, string>();
    const redis = {
      set: vi.fn(async (key: string, value: string, ...options: Array<string | number>) => {
        if (options.includes('NX') && values.has(key)) return null;
        values.set(key, value);
        return 'OK';
      }),
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      del: vi.fn(async (...keys: string[]) => keys.reduce((removed, key) => removed + Number(values.delete(key)), 0)),
      eval: vi.fn(async (_script: string, _keyCount: number, key: string, expectedHash: string) => {
        const encoded = values.get(key);
        if (!encoded) return [0];
        const pending = JSON.parse(encoded) as { codeHash: string; attempts: number };
        if (pending.codeHash !== expectedHash) return [1];
        values.delete(key);
        return [3, encoded];
      }),
    };
    const newUser = {
      id: 'registered-buyer',
      phone: '+998901234567',
      email: 'phone-998901234567@users.averon.local',
      name: 'Buyer',
      avatar: null,
      role: 'CUSTOMER',
      adminRole: null,
      isBlocked: false,
      isDeleted: false,
      adminTotpEnabled: false,
    };
    let storedPasswordHash = '';
    let isRegistered = false;
    const user = {
      findUnique: vi.fn(async () => isRegistered ? { ...newUser, passwordHash: storedPasswordHash } : null),
      create: vi.fn(async ({ data }: { data: { phone: string; passwordHash: string; verified: boolean } }) => {
        expect(data.phone).toBe('+998901234567');
        expect(await argon2.verify(data.passwordHash, 'StrongPass123!')).toBe(true);
        expect(data.verified).toBe(true);
        storedPasswordHash = data.passwordHash;
        isRegistered = true;
        return newUser;
      }),
      update: vi.fn(async () => newUser),
    };
    const app = Fastify();
    await app.register(fastifyCookie);
    await app.register(fastifyJwt, { secret: config.JWT_SECRET });
    app.decorate('redis', redis as never);
    app.decorate('prisma', {
      user,
      authSession: { upsert: vi.fn(async () => ({})) },
    } as never);
    app.post('/register/phone/request-code', requestPhoneRegistration);
    app.post('/register/phone/verify-code', verifyPhoneRegistration);
    app.post('/login/phone/request-code', requestPhonePasswordLogin);
    app.post('/login/phone/verify-code', verifyPhonePasswordLogin);
    await app.ready();

    try {
      const phone = '+998 90 123 45 67';
      const requested = await app.inject({
        method: 'POST',
        url: '/register/phone/request-code',
        payload: { name: 'Buyer', phone, password: 'StrongPass123!' },
      });
      expect(requested.statusCode).toBe(200);
      const { devCode } = requested.json() as { devCode?: string };
      expect(devCode).toMatch(/^\d{6}$/);
      expect(JSON.stringify([...values.values()])).not.toContain(devCode);

      const verified = await app.inject({
        method: 'POST',
        url: '/register/phone/verify-code',
        payload: { phone, code: devCode },
      });
      expect(verified.statusCode).toBe(200);
      expect(verified.json()).toMatchObject({ user: { id: 'registered-buyer', phone: '+998901234567' } });
      expect(verified.headers['set-cookie']).toContain('refreshToken=');
      expect(user.create).toHaveBeenCalledTimes(1);
      expect(redis.eval).toHaveBeenCalledTimes(1);

      values.delete('averon:v1:auth:phone-password:cooldown:+998901234567');
      const loginRequested = await app.inject({
        method: 'POST',
        url: '/login/phone/request-code',
        payload: { phone, password: 'StrongPass123!' },
      });
      expect(loginRequested.statusCode).toBe(200);
      const { devCode: loginCode } = loginRequested.json() as { devCode?: string };
      expect(loginCode).toMatch(/^\d{6}$/);
      expect(JSON.stringify([...values.values()])).not.toContain(loginCode);

      const loginVerified = await app.inject({
        method: 'POST',
        url: '/login/phone/verify-code',
        payload: { phone, code: loginCode },
      });
      expect(loginVerified.statusCode).toBe(200);
      expect(loginVerified.json()).toMatchObject({ user: { id: 'registered-buyer', phone: '+998901234567' } });
      expect(loginVerified.headers['set-cookie']).toContain('refreshToken=');
      expect(user.create).toHaveBeenCalledTimes(1);

      const replay = await app.inject({
        method: 'POST',
        url: '/register/phone/verify-code',
        payload: { phone, code: devCode },
      });
      expect(replay.statusCode).toBe(401);
      expect(user.create).toHaveBeenCalledTimes(1);
    } finally {
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
