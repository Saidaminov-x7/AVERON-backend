import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { describe, expect, it, vi } from 'vitest';
import { AdminRole } from '@prisma/client';
import { adminMiddleware, requireAdminRole } from '../adminMiddleware';

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

  it('denies SUPPORT access to protected fitting-room review actions', async () => {
    const findUnique = vi.fn(async () => ({
      id: 'support-user',
      role: 'USER',
      adminRole: 'SUPPORT',
      isBlocked: false,
      isDeleted: false,
    }));
    const app = Fastify();
    await app.register(fastifyJwt, {
      secret: globalThis.crypto.randomUUID().replaceAll('-', '').repeat(2),
    });
    app.decorate('prisma', { user: { findUnique } } as never);
    app.post('/admin/fitting-room/review', {
      preHandler: [requireAdminRole(AdminRole.SUPER_ADMIN, AdminRole.ADMIN, AdminRole.MODERATOR)],
    }, async () => ({ changed: true }));
    await app.ready();
    const token = app.jwt.sign({ userId: 'support-user', role: 'USER' });

    const response = await app.inject({
      method: 'POST',
      url: '/admin/fitting-room/review',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ requiredRoles: ['SUPER_ADMIN', 'ADMIN', 'MODERATOR'] });
    await app.close();
  });

  it('allows a MODERATOR to perform an approved moderation action', async () => {
    const findUnique = vi.fn(async () => ({
      id: 'moderator-user',
      role: 'USER',
      adminRole: 'MODERATOR',
      isBlocked: false,
      isDeleted: false,
    }));
    const app = Fastify();
    await app.register(fastifyJwt, {
      secret: globalThis.crypto.randomUUID().replaceAll('-', '').repeat(2),
    });
    app.decorate('prisma', { user: { findUnique } } as never);
    app.post('/admin/fitting-room/review', {
      preHandler: [requireAdminRole(AdminRole.SUPER_ADMIN, AdminRole.ADMIN, AdminRole.MODERATOR)],
    }, async () => ({ changed: true }));
    await app.ready();
    const token = app.jwt.sign({ userId: 'moderator-user', role: 'USER' });

    const response = await app.inject({
      method: 'POST',
      url: '/admin/fitting-room/review',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ changed: true });
    await app.close();
  });
});
