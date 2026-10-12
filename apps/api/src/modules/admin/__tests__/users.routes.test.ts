import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminModule } from '../index';

const apps: ReturnType<typeof Fastify>[] = [];

async function makeApp(adminRole: 'SUPER_ADMIN' | 'ADMIN' | 'SUPPORT' | 'MODERATOR') {
  const app = Fastify();
  apps.push(app);
  await app.register(fastifyJwt, {
    secret: globalThis.crypto.randomUUID().replaceAll('-', '').repeat(2),
  });
  const findUnique = vi.fn(async ({ where }: { where: { id: string } }) => (
    where.id === 'acting-admin'
      ? {
          id: 'acting-admin',
          role: 'ADMIN',
          adminRole,
          isBlocked: false,
          isDeleted: false,
        }
      : null
  ));
  app.decorate('prisma', {
    user: { findUnique },
    userActivityLog: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    authSession: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
  } as never);
  await app.register(adminModule, { prefix: '/admin' });
  await app.ready();
  return { app, findUnique };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('admin user detail authorization', () => {
  it('requires authentication before looking up a user detail record', async () => {
    const { app, findUnique } = await makeApp('SUPPORT');

    const response = await app.inject({
      method: 'GET',
      url: '/admin/users/private-user-id',
    });

    expect(response.statusCode).toBe(401);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it.each(['SUPPORT', 'MODERATOR'] as const)(
    'does not expose private user details to %s even when the JWT claims SUPER_ADMIN',
    async (adminRole) => {
      const { app, findUnique } = await makeApp(adminRole);
      const token = app.jwt.sign({
        userId: 'acting-admin',
        role: 'ADMIN',
        adminRole: 'SUPER_ADMIN',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/admin/users/private-user-id',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(403);
      expect(findUnique).toHaveBeenCalledTimes(1);
      expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'acting-admin' },
      }));
    },
  );

  it.each([
    '/admin/users/private-user-id/activity',
    '/admin/users/private-user-id/sessions',
  ])('does not expose private account activity and session metadata at %s to support', async (url) => {
    const { app } = await makeApp('SUPPORT');
    const token = app.jwt.sign({ userId: 'acting-admin', role: 'ADMIN', adminRole: 'SUPER_ADMIN' });

    const response = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
  });

  it.each([
    '/admin/users/private-user-id/activity',
    '/admin/users/private-user-id/sessions',
  ])('does not expose private account activity and session metadata at %s to moderators', async (url) => {
    const { app } = await makeApp('MODERATOR');
    const token = app.jwt.sign({ userId: 'acting-admin', role: 'ADMIN', adminRole: 'SUPER_ADMIN' });

    const response = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
  });

  it.each(['ADMIN', 'SUPER_ADMIN'] as const)(
    'allows %s to view account activity and active sessions',
    async (adminRole) => {
      const { app } = await makeApp(adminRole);
      const token = app.jwt.sign({ userId: 'acting-admin', role: 'ADMIN', adminRole: 'SUPPORT' });

      for (const url of [
        '/admin/users/private-user-id/activity',
        '/admin/users/private-user-id/sessions',
      ]) {
        const response = await app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(200);
      }
    },
  );
});
