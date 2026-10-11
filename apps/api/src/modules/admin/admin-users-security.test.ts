import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL ??= 'postgresql://averon_test:averon_test@127.0.0.1:5432/averon_test';
  process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
  process.env.JWT_SECRET ??= 'test-admin-users-access-secret-32-chars';
  process.env.REFRESH_SECRET ??= 'test-admin-users-refresh-secret-32';
});

import { adminModule } from './index';

const secret = 'test-admin-users-access-secret-32-chars';

function makeApp(
  adminRole: string | null,
  listUsers: () => Promise<unknown[]> = async () => {
    throw new Error('Prisma connection failed: postgres://private-host/secret');
  },
  totalUsers = 0,
) {
  const findMany = vi.fn(listUsers);
  const count = vi.fn(async () => totalUsers);
  const findUnique = vi.fn(async () => ({
    id: 'admin-user',
    role: adminRole ? 'ADMIN' : 'USER',
    adminRole,
    isBlocked: false,
    isDeleted: false,
  }));
  const app = Fastify();
  app.decorate('prisma', {
    user: { findUnique, findMany, count },
    $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
  } as never);

  return { app, findMany, findUnique };
}

async function registerRoutes(app: ReturnType<typeof Fastify>) {
  await app.register(fastifyJwt, { secret });
  await app.register(adminModule, { prefix: '/admin' });
  await app.ready();
}

describe('admin user API security', () => {
  it('requires authentication even when the exact users endpoint and query are known', async () => {
    const { app, findUnique, findMany } = makeApp('SUPER_ADMIN');
    await registerRoutes(app);

    const response = await app.inject({ method: 'GET', url: '/admin/users?all=1' });

    expect(response.statusCode).toBe(401);
    expect(findUnique).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    await app.close();
  });

  it('denies a normal account and never runs the user-list query', async () => {
    const { app, findMany } = makeApp(null);
    await registerRoutes(app);
    const token = app.jwt.sign({ userId: 'admin-user', role: 'USER' });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/users?all=1',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    expect(findMany).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns a generic 500 rather than exposing database details', async () => {
    const { app } = makeApp('SUPER_ADMIN');
    await registerRoutes(app);
    const token = app.jwt.sign({ userId: 'admin-user', role: 'ADMIN' });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/users',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ message: 'An internal error occurred' });
    expect(response.body).not.toContain('postgres://');
    expect(response.body).not.toContain('private-host');
    await app.close();
  });

  it('keeps the admin user list paginated and excludes credential fields', async () => {
    const safeUser = {
      id: 'user-1',
      name: 'Customer',
      email: 'customer@example.test',
      phone: '+998901234567',
      role: 'USER',
      adminRole: null,
      verified: true,
      isBlocked: false,
      blockedAt: null,
      blockedReason: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      avatar: null,
      lastLoginAt: null,
    };
    const { app, findMany } = makeApp('SUPER_ADMIN', async () => [safeUser], 42);
    await registerRoutes(app);
    const token = app.jwt.sign({ userId: 'admin-user', role: 'ADMIN' });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/users?all=1&page=2&limit=5',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [{ id: 'user-1', email: 'customer@example.test' }],
      meta: { total: 42, page: 2, limit: 5, totalPages: 9 },
    });
    expect(response.json().items[0]).not.toHaveProperty('passwordHash');
    expect(response.json().items[0]).not.toHaveProperty('refreshTokenHash');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 5, take: 5 }));
    await app.close();
  });
});
