import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgresql://127.0.0.1:5432/test';
  process.env.REDIS_URL = 'redis://127.0.0.1:6379';
  process.env.JWT_SECRET = 'test-jwt-secret-with-more-than-32-characters';
  process.env.REFRESH_SECRET = 'test-refresh-secret-with-more-than-32-characters';
  process.env.NODE_ENV = 'test';
  process.env.FEATURE_SMS_VERIFICATION = 'true';
});

import { requestPhoneRegistration, verifyPhoneRegistration } from '../phone-password';

describe('phone password OTP security', () => {
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
