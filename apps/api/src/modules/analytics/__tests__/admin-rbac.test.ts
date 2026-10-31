import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { describe, expect, it, vi } from 'vitest';
import { analyticsModule } from '../index';

const analyticsRoutes = [
  '/analytics/admin/visitors',
  '/analytics/admin/range',
  '/analytics/admin/export?type=visitors',
  '/analytics/funnel',
];

async function buildApp(adminRole: 'SUPER_ADMIN' | 'ADMIN' | 'MODERATOR' | 'SUPPORT' | null) {
  const app = Fastify();
  await app.register(fastifyJwt, { secret: 'a'.repeat(64) });
  const groupBy = vi.fn(async () => []);
  const findMany = vi.fn(async () => []);
  const count = vi.fn(async () => 0);
  app.decorate('prisma', {
    authSession: { findFirst: vi.fn(async () => ({ id: 'test-session' })) },
    user: {
      findUnique: vi.fn(async () => ({
        id: 'staff-user',
        role: 'USER',
        adminRole,
        isBlocked: false,
        isDeleted: false,
      })),
      findMany,
    },
    visitLog: { groupBy, count },
    commerceProduct: { findMany },
    commerceOrder: { findMany, count },
    productFavorite: { count },
  } as never);
  await app.register(analyticsModule, { prefix: '/analytics' });
  const token = app.jwt.sign({ sessionId: 'test-session', userId: 'staff-user', role: 'ADMIN', adminRole: 'SUPER_ADMIN' });
  return { app, token, groupBy, findMany, count };
}

describe('analytics admin RBAC', () => {
  it.each(analyticsRoutes)('requires authentication for %s', async (url) => {
    const { app } = await buildApp('SUPPORT');
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it.each(['SUPPORT', 'MODERATOR'] as const)(
    'denies %s even when JWT claims SUPER_ADMIN for every analytics endpoint',
    async (role) => {
      const { app, token, groupBy, findMany, count } = await buildApp(role);
      for (const url of analyticsRoutes) {
        const response = await app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(403);
      }
      expect(groupBy).not.toHaveBeenCalled();
      expect(findMany).not.toHaveBeenCalled();
      expect(count).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it.each(['ADMIN', 'SUPER_ADMIN'] as const)(
    'allows %s for analytics while using the current database role',
    async (role) => {
      const { app, token } = await buildApp(role);
      const response = await app.inject({
        method: 'GET',
        url: '/analytics/admin/visitors',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      await app.close();
    },
  );
});
