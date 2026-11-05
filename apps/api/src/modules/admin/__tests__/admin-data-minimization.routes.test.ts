import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminModule } from '../index';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL ??= 'postgresql://averon_test:averon_test@127.0.0.1:5432/averon_test';
  process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
  process.env.JWT_SECRET ??= 'test-admin-data-minimization-access-secret';
  process.env.REFRESH_SECRET ??= 'test-admin-data-minimization-refresh-secret';
});

const JWT_SECRET = process.env.JWT_SECRET || 'test-admin-data-minimization-access-secret';
const apps: ReturnType<typeof Fastify>[] = [];

async function makeApp() {
  const app = Fastify();
  apps.push(app);
  await app.register(fastifyJwt, { secret: JWT_SECRET });

  const user = {
    id: 'restored-user',
    role: 'USER',
    adminRole: null,
    isBlocked: false,
    isDeleted: false,
    name: 'Restored User',
    email: 'restored@example.test',
    phone: '+998901234567',
    passwordHash: '$argon2id$private-hash',
    refreshTokenHash: 'private-refresh-hash',
    twoFactorSecret: 'private-totp-secret',
    adminTotpSecret: 'private-admin-totp-secret',
    adminTotpLastCounter: null,
    wishlistShareToken: 'private-share-token',
    deletedAt: null,
    verified: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  const userFindUnique = vi.fn(async ({ where }: { where: { id: string } }) => (
    where.id === 'admin-user'
      ? { id: 'admin-user', role: 'ADMIN', adminRole: 'SUPER_ADMIN', isBlocked: false, isDeleted: false }
      : null
  ));
  const userUpdate = vi.fn(async ({ select }: { select: Record<string, boolean> }) => (
    Object.fromEntries(Object.keys(select).map((field) => [field, user[field as keyof typeof user]]))
  ));
  const visitLogFindMany = vi.fn(async () => [{
    id: 'visit-row-1',
    deviceId: 'device-identifier-secret',
    dayKey: '2026-01-02',
    ip: '203.0.113.17',
    userAgent: 'Private Browser Fingerprint',
    path: '/catalog/item-7',
    createdAt: new Date('2026-01-02T12:00:00.000Z'),
  }]);

  app.decorate('prisma', {
    user: { findUnique: userFindUnique, update: userUpdate },
    visitLog: { findMany: visitLogFindMany },
    authSession: { findFirst: vi.fn(async () => ({ id: 'test-session' })) },
  } as never);
  await app.register(adminModule, { prefix: '/admin' });
  await app.ready();

  const token = app.jwt.sign({
    userId: 'admin-user',
    role: 'ADMIN',
    adminRole: 'SUPER_ADMIN',
    sessionId: 'test-session',
  });
  return { app, token, userUpdate, visitLogFindMany };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('admin data minimization', () => {
  it('returns only a safe user summary after restore', async () => {
    const { app, token, userUpdate } = await makeApp();

    const response = await app.inject({
      method: 'POST',
      url: '/admin/users/restored-user/restore',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      user: {
        id: 'restored-user',
        name: 'Restored User',
        role: 'USER',
        isDeleted: false,
      },
    });
    expect(response.body).not.toContain('argon2id');
    expect(response.body).not.toContain('private-refresh-hash');
    expect(response.body).not.toContain('private-totp-secret');
    expect(response.body).not.toContain('private-share-token');
    expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({
      select: { id: true, name: true, role: true, isDeleted: true },
    }));
  });

  it('omits direct visitor identifiers from the visitor CSV export', async () => {
    const { app, token, visitLogFindMany } = await makeApp();

    const response = await app.inject({
      method: 'GET',
      url: '/admin/analytics/export?type=visitors&from=2026-01-01&to=2026-01-03',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.body).toContain('2026-01-02');
    expect(response.body).toContain('/catalog/item-7');
    expect(response.body).not.toContain('device-identifier-secret');
    expect(response.body).not.toContain('203.0.113.17');
    expect(response.body).not.toContain('Private Browser Fingerprint');
    expect(response.body).not.toContain('Device ID');
    expect(response.body).not.toContain('IP Address');
    expect(response.body).not.toContain('User Agent');
    expect(visitLogFindMany).toHaveBeenCalledOnce();
  });
});
