import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findByEmail, verifyPassword } = vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test';
  process.env.REDIS_URL = 'redis://127.0.0.1:6379';
  process.env.JWT_SECRET = 'test-jwt-secret-with-more-than-32-characters';
  process.env.REFRESH_SECRET = 'test-refresh-secret-with-more-than-32-characters';
  process.env.NODE_ENV = 'test';
  return { findByEmail: vi.fn(), verifyPassword: vi.fn() };
});

vi.mock('../service', () => ({
  AuthService: class {
    findByEmail = findByEmail;
    verifyPassword = verifyPassword;
  },
}));

import { loginHandler } from '../login';
import { requestPhonePasswordLogin } from '../phone-password';

describe('email login failure throttling', () => {
  beforeEach(() => {
    findByEmail.mockReset().mockResolvedValue(null);
    verifyPassword.mockReset().mockResolvedValue(false);
  });

  it('temporarily rejects further login attempts after repeated failures', async () => {
    const values = new Map<string, number>();
    const redis = {
      get: vi.fn(async (key: string) => values.has(key) ? String(values.get(key)) : null),
      eval: vi.fn(async (_script: string, _keyCount: number, key: string) => {
        const next = (values.get(key) ?? 0) + 1;
        values.set(key, next);
        return next;
      }),
      del: vi.fn(async (key: string) => values.delete(key) ? 1 : 0),
    };
    const app = Fastify();
    app.decorate('redis', redis as never);
    app.post('/login', loginHandler);
    await app.ready();

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/login',
        payload: { email: 'user@example.test', password: 'incorrect' },
      });
      expect(response.statusCode).toBe(401);
    }

    const throttled = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { email: 'user@example.test', password: 'incorrect' },
    });
    expect(throttled.statusCode).toBe(429);
    expect(findByEmail).toHaveBeenCalledTimes(8);
    expect(verifyPassword).toHaveBeenCalledTimes(8);
    expect(verifyPassword).toHaveBeenNthCalledWith(1, expect.stringMatching(/^\$argon2/), 'incorrect');
    expect(redis.eval).toHaveBeenCalledTimes(8);
    await app.close();
  });

  it('clears the shared failed-attempt counter after a successful password check', async () => {
    const values = new Map<string, number>();
    const redis = {
      get: vi.fn(async (key: string) => values.has(key) ? String(values.get(key)) : null),
      eval: vi.fn(async (_script: string, _keyCount: number, key: string) => {
        const next = (values.get(key) ?? 0) + 1;
        values.set(key, next);
        return next;
      }),
      del: vi.fn(async (key: string) => values.delete(key) ? 1 : 0),
      set: vi.fn(async () => 'OK'),
    };
    const user = {
      id: 'admin-id',
      email: 'user@example.test',
      role: 'ADMIN',
      adminRole: 'SUPER_ADMIN',
      adminTotpEnabled: true,
      isBlocked: false,
      isDeleted: false,
    };
    findByEmail.mockResolvedValue(user);
    verifyPassword.mockResolvedValue(true);
    const app = Fastify();
    app.decorate('redis', redis as never);
    app.post('/login', loginHandler);
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { email: 'user@example.test', password: 'CorrectPassword1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ requireTotp: true });
    expect(redis.del).toHaveBeenCalledOnce();
    await app.close();
  });

  it('temporarily limits repeated phone-password failures with shared Redis state', async () => {
    const values = new Map<string, number>();
    const redis = {
      get: vi.fn(async (key: string) => values.has(key) ? String(values.get(key)) : null),
      eval: vi.fn(async (_script: string, _keyCount: number, key: string) => {
        const next = (values.get(key) ?? 0) + 1;
        values.set(key, next);
        return next;
      }),
      del: vi.fn(async (key: string) => values.delete(key) ? 1 : 0),
    };
    const findUnique = vi.fn(async () => null);
    const app = Fastify();
    app.decorate('redis', redis as never);
    app.decorate('prisma', { user: { findUnique } } as never);
    app.post('/phone-login', requestPhonePasswordLogin);
    await app.ready();

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/phone-login',
        payload: { phone: '+998 90 123 45 67', password: 'incorrect' },
      });
      expect(response.statusCode).toBe(401);
    }
    const throttled = await app.inject({
      method: 'POST',
      url: '/phone-login',
      payload: { phone: '90-123-45-67', password: 'incorrect' },
    });

    expect(throttled.statusCode).toBe(429);
    expect(findUnique).toHaveBeenCalledTimes(8);
    expect(redis.eval).toHaveBeenCalledTimes(8);
    await app.close();
  });
});
