import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { themeModule } from '../theme';

const apps: ReturnType<typeof Fastify>[] = [];

async function makeApp(user: Record<string, unknown> | null) {
  const app = Fastify();
  apps.push(app);
  await app.register(fastifyJwt, {
    secret: globalThis.crypto.randomUUID().replaceAll('-', '').repeat(2),
  });
  app.decorate('prisma', {
    user: { findUnique: vi.fn(async () => user) },
  } as never);
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
    const token = app.jwt.sign({ userId: 'customer-1', role: 'CUSTOMER' });

    const response = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: { primaryColor: '#123456' },
    });

    expect(response.statusCode).toBe(403);
  });
});
