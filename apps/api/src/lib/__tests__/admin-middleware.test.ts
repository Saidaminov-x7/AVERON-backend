import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { describe, expect, it, vi } from 'vitest';
import { adminMiddleware } from '../adminMiddleware';

describe('admin authorization', () => {
  it('denies a soft-deleted administrator even when the access token is valid', async () => {
    const findUnique = vi.fn(async () => ({
      id: 'deleted-admin',
      role: 'ADMIN',
      adminRole: 'SUPER_ADMIN',
      isBlocked: false,
      isDeleted: true,
    }));
    const app = Fastify();
    await app.register(fastifyJwt, {
      secret: globalThis.crypto.randomUUID().replaceAll('-', '').repeat(2),
    });
    app.decorate('prisma', { user: { findUnique } } as never);
    app.get('/admin', { preHandler: adminMiddleware }, async () => ({ ok: true }));
    await app.ready();
    const token = app.jwt.sign({ userId: 'deleted-admin', role: 'ADMIN' });

    const response = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ isDeleted: true }),
    }));
    await app.close();
  });
});
