import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/averon_test';
  process.env.REDIS_URL = 'redis://127.0.0.1:6379/15';
  process.env.JWT_SECRET = 'test-auth-access-secret-that-is-long-enough';
  process.env.REFRESH_SECRET = 'test-auth-refresh-secret-that-is-long-enough';
});

import { authModule } from '../index';

describe('unauthenticated personal data access', () => {
  it('blocks a direct request for the personal data export before querying user data', async () => {
    const findUnique = vi.fn();
    const app = Fastify();
    app.decorate('prisma', { user: { findUnique } } as never);
    await app.register(fastifyJwt, { secret: 'test-auth-access-secret-that-is-long-enough' });
    await app.register(authModule, { prefix: '/auth' });

    try {
      const response = await app.inject({ method: 'GET', url: '/auth/me/export' });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ message: 'Unauthorized' });
      expect(findUnique).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
