import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { profileModule } from '../profile';
import { themeModule } from '../theme';

const apps: ReturnType<typeof Fastify>[] = [];

async function makeApp(user: Record<string, unknown> | null) {
  const app = Fastify();
  apps.push(app);
  await app.register(fastifyJwt, {
    secret: globalThis.crypto.randomUUID().replaceAll('-', '').repeat(2),
  });
  app.decorate('prisma', {
    authSession: { findFirst: vi.fn(async () => ({ id: 'test-session' })) },
    user: { findUnique: vi.fn(async () => user) },
    adminThemeSettings: {
      upsert: vi.fn(async () => ({ id: 'singleton', primaryColor: '#2563eb' })),
    },
  } as never);
  await app.register(profileModule, { prefix: '/admin' });
  await app.register(themeModule, { prefix: '/admin' });
  await app.ready();
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('admin theme routes authorization', () => {
  it.each([
    ['GET', '/admin/admin-theme'],
    ['PATCH', '/admin/admin-theme'],
  ] as const)('%s %s rejects requests without a token', async (method, url) => {
    const app = await makeApp(null);

    const response = await app.inject({ method, url, payload: { primaryColor: '#123456' } });

    expect(response.statusCode).toBe(401);
  });

  it.each([
    ['CUSTOMER', null, 403],
    ['ADMIN', 'SUPPORT', 403],
    ['ADMIN', 'MODERATOR', 403],
    ['ADMIN', 'ADMIN', 403],
    ['ADMIN', 'SUPER_ADMIN', 200],
  ] as const)('GET /admin/admin-theme enforces current database role %s/%s', async (role, adminRole, expectedStatus) => {
    const userId = 'role-matrix-user';
    const app = await makeApp({
      id: userId,
      role,
      adminRole,
      isBlocked: false,
      isDeleted: false,
    });
    const token = app.jwt.sign({ sessionId: 'test-session', userId, role: 'ADMIN', adminRole: 'SUPER_ADMIN' });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/admin-theme',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(expectedStatus);
    if (expectedStatus === 200) {
      expect(response.json()).toMatchObject({ primaryColor: '#2563eb' });
    } else {
      const updateResponse = await app.inject({
        method: 'PATCH',
        url: '/admin/admin-theme',
        headers: { authorization: `Bearer ${token}` },
        payload: { primaryColor: '#123456' },
      });

      expect(updateResponse.statusCode).toBe(expectedStatus);
    }
  });

  it.each([
    ['blocked', { isBlocked: true, isDeleted: false }],
    ['deleted', { isBlocked: false, isDeleted: true }],
  ] as const)('%s admin account cannot access theme routes with a valid super-admin JWT', async (_state, accountState) => {
    const app = await makeApp({
      id: 'inactive-admin',
      role: 'ADMIN',
      adminRole: 'SUPER_ADMIN',
      ...accountState,
    });
    const token = app.jwt.sign({ sessionId: 'test-session', userId: 'inactive-admin', role: 'ADMIN', adminRole: 'SUPER_ADMIN' });

    for (const [method, url] of [
      ['GET', '/admin/admin-theme'],
      ['PATCH', '/admin/admin-theme'],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        payload: { primaryColor: '#123456' },
      });

      expect(response.statusCode).toBe(403);
    }
  });

  it.each([
    ['GET', '/admin/admin-theme'],
    ['PATCH', '/admin/admin-theme'],
  ] as const)('%s %s rejects an authenticated non-admin', async (method, url) => {
    const app = await makeApp({
      id: 'customer-1',
      role: 'CUSTOMER',
      adminRole: null,
      isBlocked: false,
      isDeleted: false,
    });
    const token = app.jwt.sign({ sessionId: 'test-session', userId: 'customer-1', role: 'CUSTOMER' });

    const response = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: { primaryColor: '#123456' },
    });

    expect(response.statusCode).toBe(403);
  });

  it.each([
    ['GET', '/admin/admin-theme'],
    ['PATCH', '/admin/admin-theme'],
  ] as const)('%s %s rejects an admin without the required role, regardless of JWT claims', async (method, url) => {
    const app = await makeApp({
      id: 'limited-admin',
      role: 'ADMIN',
      adminRole: 'ADMIN',
      isBlocked: false,
      isDeleted: false,
    });
    const token = app.jwt.sign({ sessionId: 'test-session', userId: 'limited-admin', role: 'ADMIN', adminRole: 'SUPER_ADMIN' });

    const response = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: { primaryColor: '#123456' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ requiredRoles: ['SUPER_ADMIN'] });
  });
});

describe('admin profile routes authorization', () => {
  it.each([
    ['PATCH', '/admin/profile'],
    ['PATCH', '/admin/profile/password'],
  ] as const)('%s %s rejects requests without a token', async (method, url) => {
    const app = await makeApp(null);

    const response = await app.inject({ method, url, payload: {} });

    expect(response.statusCode).toBe(401);
  });

  it.each([
    ['PATCH', '/admin/profile'],
    ['PATCH', '/admin/profile/password'],
  ] as const)('%s %s rejects an authenticated non-admin before accepting profile fields', async (method, url) => {
    const app = await makeApp({
      id: 'customer-1',
      role: 'CUSTOMER',
      adminRole: null,
      isBlocked: false,
      isDeleted: false,
    });
    const token = app.jwt.sign({ sessionId: 'test-session', userId: 'customer-1', role: 'CUSTOMER' });

    const response = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Changed Name', role: 'SUPER_ADMIN', id: 'another-user' },
    });

    expect(response.statusCode).toBe(403);
  });
});
