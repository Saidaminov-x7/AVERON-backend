import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { describe, expect, it, vi } from 'vitest';
import { AdminRole } from '@prisma/client';
import { adminMiddleware, requireAdminRole } from '../adminMiddleware';

const ACTIVE_SESSION_ID = 'active-session';


const ADMIN_ROLES = [
  AdminRole.SUPER_ADMIN,
  AdminRole.ADMIN,
  AdminRole.MODERATOR,
  AdminRole.SUPPORT,
] as const;

const ADMIN_ROUTE_POLICIES = [
  { path: '/admin/catalog/read', roles: ADMIN_ROLES },
  { path: '/admin/catalog/manage', roles: [AdminRole.SUPER_ADMIN, AdminRole.ADMIN] },
  { path: '/admin/analytics', roles: [AdminRole.SUPER_ADMIN, AdminRole.ADMIN] },
  { path: '/admin/moderation', roles: [AdminRole.SUPER_ADMIN, AdminRole.ADMIN, AdminRole.MODERATOR] },
  { path: '/admin/staff', roles: [AdminRole.SUPER_ADMIN] },
] as const;

async function makeRoleMatrixApp(resolveUser: (userId: string) => Promise<{
  id: string;
  role: string;
  adminRole: AdminRole | null;
  isBlocked: boolean;
  isDeleted: boolean;
} | null>) {
  const app = Fastify();
  await app.register(fastifyJwt, {
    secret: globalThis.crypto.randomUUID().replaceAll('-', '').repeat(2),
  });
  app.decorate('prisma', {
    authSession: { findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string; revokedAt: null; expiresAt: { gt: Date } } }) => where.id === ACTIVE_SESSION_ID ? { id: ACTIVE_SESSION_ID } : null) },
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => resolveUser(where.id)) },
  } as never);
  for (const policy of ADMIN_ROUTE_POLICIES) {
    app.get(policy.path, {
      preHandler: [requireAdminRole(...policy.roles)],
    }, async () => ({ route: policy.path }));
  }
  await app.ready();
  return app;
}

describe('admin authorization', () => {
  it('enforces the server-side role matrix for actual admin permission groups', async () => {
    const users = new Map(ADMIN_ROLES.map((adminRole) => [adminRole, {
      id: `test-${adminRole.toLowerCase()}`,
      role: 'USER',
      adminRole,
      isBlocked: false,
      isDeleted: false,
    }]));
    const app = await makeRoleMatrixApp(async (userId) =>
      [...users.values()].find((user) => user.id === userId) ?? null,
    );

    try {
      for (const adminRole of ADMIN_ROLES) {
        const user = users.get(adminRole)!;
        const token = app.jwt.sign({ userId: user.id, role: user.role, sessionId: ACTIVE_SESSION_ID });
        for (const policy of ADMIN_ROUTE_POLICIES) {
          const response = await app.inject({
            method: 'GET',
            url: policy.path,
            headers: { authorization: `Bearer ${token}` },
          });
          expect(response.statusCode, `${adminRole} -> ${policy.path}`).toBe(
            policy.roles.includes(adminRole as never) ? 200 : 403,
          );
        }
      }
    } finally {
      await app.close();
    }
  }, 15_000);

  it('returns 401 for missing or invalid credentials and ignores stale admin claims', async () => {
    const app = await makeRoleMatrixApp(async (userId) => userId === 'ordinary-user'
      ? { id: userId, role: 'USER', adminRole: null, isBlocked: false, isDeleted: false }
      : null,
    );

    try {
      expect((await app.inject({ method: 'GET', url: '/admin/staff' })).statusCode).toBe(401);
      expect((await app.inject({
        method: 'GET',
        url: '/admin/staff',
        headers: { authorization: 'Bearer invalid-token' },
      })).statusCode).toBe(401);

      const staleAdminToken = app.jwt.sign({ userId: 'ordinary-user', role: 'ADMIN', sessionId: ACTIVE_SESSION_ID });
      const denied = await app.inject({
        method: 'GET',
        url: '/admin/staff',
        headers: { authorization: `Bearer ${staleAdminToken}` },
      });
      expect(denied.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

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
    app.decorate('prisma', { authSession: { findFirst: vi.fn(async () => ({ id: ACTIVE_SESSION_ID })) }, user: { findUnique } } as never);
    app.get('/admin', { preHandler: adminMiddleware }, async () => ({ ok: true }));
    await app.ready();
    const token = app.jwt.sign({ userId: 'deleted-admin', role: 'ADMIN', sessionId: ACTIVE_SESSION_ID });

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
    app.decorate('prisma', { authSession: { findFirst: vi.fn(async () => ({ id: ACTIVE_SESSION_ID })) }, user: { findUnique } } as never);
    app.post('/admin/fitting-room/review', {
      preHandler: [requireAdminRole(AdminRole.SUPER_ADMIN, AdminRole.ADMIN, AdminRole.MODERATOR)],
    }, async () => ({ changed: true }));
    await app.ready();
    const token = app.jwt.sign({ userId: 'support-user', role: 'USER', sessionId: ACTIVE_SESSION_ID });

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
    app.decorate('prisma', { authSession: { findFirst: vi.fn(async () => ({ id: ACTIVE_SESSION_ID })) }, user: { findUnique } } as never);
    app.post('/admin/fitting-room/review', {
      preHandler: [requireAdminRole(AdminRole.SUPER_ADMIN, AdminRole.ADMIN, AdminRole.MODERATOR)],
    }, async () => ({ changed: true }));
    await app.ready();
    const token = app.jwt.sign({ userId: 'moderator-user', role: 'USER', sessionId: ACTIVE_SESSION_ID });

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
