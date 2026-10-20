import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { describe, expect, it, vi } from 'vitest';
import { authMiddleware } from './authMiddleware';

const JWT_SECRET = 'test-auth-access-secret-that-is-long-enough';

describe('authMiddleware account state checks', () => {
  it.each([
    ['blocked', { isBlocked: true, isDeleted: false }],
    ['deleted', { isBlocked: false, isDeleted: true }],
    ['missing', null],
  ])('rejects a still-valid token for a %s account', async (_label, account) => {
    const findUnique = vi.fn().mockResolvedValue(account);
    const app = Fastify();
    app.decorate('prisma', { user: { findUnique } } as never);
    await app.register(fastifyJwt, { secret: JWT_SECRET });
    app.get('/private', { preHandler: authMiddleware }, async () => ({ ok: true }));

    try {
      const token = app.jwt.sign({ userId: 'user-1', role: 'USER' });
      const response = await app.inject({
        method: 'GET',
        url: '/private',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ message: 'User account is blocked or unavailable' });
      expect(findUnique).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        select: { isBlocked: true, isDeleted: true },
      });
    } finally {
      await app.close();
    }
  });

  it('allows a valid token when the account is active', async () => {
    const findUnique = vi.fn().mockResolvedValue({ isBlocked: false, isDeleted: false });
    const app = Fastify();
    app.decorate('prisma', { user: { findUnique } } as never);
    await app.register(fastifyJwt, { secret: JWT_SECRET });
    app.get('/private', { preHandler: authMiddleware }, async () => ({ ok: true }));

    try {
      const token = app.jwt.sign({ userId: 'user-1', role: 'USER' });
      const response = await app.inject({
        method: 'GET',
        url: '/private',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });
});
