import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commerceOrdersModule } from '../orders';

const apps: ReturnType<typeof Fastify>[] = [];

async function makeApp(adminRole: 'SUPER_ADMIN' | 'ADMIN' | 'MODERATOR' | 'SUPPORT') {
  const app = Fastify();
  apps.push(app);
  await app.register(fastifyJwt, { secret: 'c'.repeat(64) });
  const findMany = vi.fn(async () => []);
  app.decorate('prisma', {
    authSession: { findFirst: vi.fn(async () => ({ id: 'test-session' })) },
    user: {
      findUnique: vi.fn(async () => ({
        id: 'staff-user',
        role: 'ADMIN',
        adminRole,
        isBlocked: false,
        isDeleted: false,
      })),
    },
    commerceOrder: { findMany },
  } as never);
  await app.register(commerceOrdersModule, { prefix: '/api/v1' });
  await app.ready();
  const token = app.jwt.sign({ sessionId: 'test-session', userId: 'staff-user', role: 'ADMIN', adminRole: 'SUPER_ADMIN' });
  return { app, token, findMany };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('admin order role policy', () => {
  it('denies support access to customer order details and mutations', async () => {
    const { app, token, findMany } = await makeApp('SUPPORT');
    const headers = { authorization: `Bearer ${token}` };
    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/orders', headers });
    const update = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/orders/AV-123/status',
      headers,
      payload: {},
    });

    expect(list.statusCode).toBe(403);
    expect(findMany).not.toHaveBeenCalled();
    expect(update.statusCode).toBe(403);
  });

  it('prevents moderators from accessing customer order data', async () => {
    const { app, token, findMany } = await makeApp('MODERATOR');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    expect(findMany).not.toHaveBeenCalled();
  });

  it.each(['ADMIN', 'SUPER_ADMIN'] as const)(
    'allows %s to list and manage orders',
    async (adminRole) => {
      const { app, token } = await makeApp(adminRole);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/orders',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
    },
  );
});
