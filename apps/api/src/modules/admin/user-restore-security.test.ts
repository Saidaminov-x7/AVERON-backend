import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { describe, expect, it, vi } from 'vitest';
import { adminModule } from './index';

const JWT_SECRET = 'test-auth-access-secret-that-is-long-enough';

describe('admin user restore response', () => {
  it('denies anonymous restore requests before reading or modifying users', async () => {
    const findUnique = vi.fn();
    const update = vi.fn();
    const app = Fastify();
    app.decorate('prisma', { user: { findUnique, update } } as never);
    await app.register(fastifyJwt, { secret: JWT_SECRET });
    await app.register(adminModule, { prefix: '/admin' });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/users/user-1/restore',
      });

      expect(response.statusCode).toBe(401);
      expect(findUnique).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('selects and returns user fields without credentials or secrets', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'admin-1',
      role: 'ADMIN',
      adminRole: 'ADMIN',
      isBlocked: false,
      isDeleted: false,
    });
    const update = vi.fn().mockResolvedValue({
      id: 'user-1',
      isDeleted: false,
    });
    const app = Fastify();
    app.decorate('prisma', { user: { findUnique, update } } as never);
    await app.register(fastifyJwt, { secret: JWT_SECRET });
    await app.register(adminModule, { prefix: '/admin' });

    try {
      const token = app.jwt.sign({ userId: 'admin-1', role: 'ADMIN' });
      const response = await app.inject({
        method: 'POST',
        url: '/admin/users/user-1/restore',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({ success: true, user: { id: 'user-1', isDeleted: false } });
      for (const secretField of [
        'passwordHash',
        'refreshTokenHash',
        'twoFactorSecret',
        'adminTotpSecret',
        'adminTotpLastCounter',
        'wishlistShareToken',
      ]) {
        expect(body.user).not.toHaveProperty(secretField);
      }
      expect(update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'user-1' },
        data: { isDeleted: false, deletedAt: null },
        select: { id: true, isDeleted: true },
      }));
      const selection = update.mock.calls[0][0].select as Record<string, unknown>;
      for (const secretField of [
        'passwordHash',
        'refreshTokenHash',
        'twoFactorSecret',
        'adminTotpSecret',
        'adminTotpLastCounter',
        'wishlistShareToken',
      ]) {
        expect(selection).not.toHaveProperty(secretField);
      }
    } finally {
      await app.close();
    }
  });
});
