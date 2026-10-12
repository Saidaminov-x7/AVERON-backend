import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminModule } from '../index';

const apps: ReturnType<typeof Fastify>[] = [];

async function makeApp(adminRole: 'SUPPORT' | 'MODERATOR') {
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
  app.decorate('prisma', { user: { findUnique } } as never);
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
});
