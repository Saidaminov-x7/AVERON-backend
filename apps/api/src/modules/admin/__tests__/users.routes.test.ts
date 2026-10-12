import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminModule } from '../index';

const apps: ReturnType<typeof Fastify>[] = [];
type TestUserRecord = {
  id: string;
  role: string;
  adminRole?: 'SUPER_ADMIN' | 'ADMIN' | 'SUPPORT' | 'MODERATOR' | null;
  isBlocked: boolean;
  isDeleted?: boolean;
  name?: string;
  email?: string;
  blockedAt?: Date | null;
};

async function makeApp(adminRole: 'SUPER_ADMIN' | 'ADMIN' | 'SUPPORT' | 'MODERATOR') {
  const app = Fastify();
  apps.push(app);
  await app.register(fastifyJwt, {
    secret: globalThis.crypto.randomUUID().replaceAll('-', '').repeat(2),
  });
  const findUnique = vi.fn(async ({ where }: { where: { id: string } }): Promise<TestUserRecord | null> => (
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
  const userRows = [{
    id: 'visible-user',
    name: 'Visible User',
    email: 'private@example.test',
    phone: '+998901234567',
    role: 'USER',
    adminRole: null,
    verified: true,
    isBlocked: false,
    blockedAt: null,
    blockedReason: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    avatar: null,
    lastLoginAt: new Date('2026-01-02T00:00:00Z'),
  }];
  const targetUser = {
    id: 'moderated-user',
    name: 'Moderated User',
    email: 'moderated@example.test',
    role: 'USER',
    isBlocked: false,
    blockedAt: null as Date | null,
  };
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...targetUser, ...data }));
  findUnique.mockImplementation(async ({ where }) => {
    if (where.id === 'acting-admin') {
      return { id: 'acting-admin', role: 'ADMIN', adminRole, isBlocked: false, isDeleted: false };
    }
    return where.id === 'moderated-user' ? targetUser : null;
  });
  const findMany = vi.fn(async (_args: { where?: unknown; select?: Record<string, boolean> }) => userRows);
  const count = vi.fn(async () => userRows.length);
  app.decorate('prisma', {
    user: { findUnique, findMany, count, update },
    userActivityLog: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    authSession: { findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
  } as never);
  await app.register(adminModule, { prefix: '/admin' });
  await app.ready();
  return { app, findUnique, findMany, update };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('admin user detail authorization', () => {
  it.each(['SUPPORT', 'MODERATOR'] as const)(
    'provides %s a safe user directory without contact data',
    async (adminRole) => {
      const { app } = await makeApp(adminRole);
      const token = app.jwt.sign({ userId: 'acting-admin', role: 'ADMIN', adminRole: 'SUPER_ADMIN' });
      const response = await app.inject({
        method: 'GET',
        url: '/admin/users?search=Visible',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().items).toEqual([expect.objectContaining({
        id: 'visible-user',
        name: 'Visible User',
        role: 'USER',
        verified: true,
        isBlocked: false,
      })]);
      expect(response.json().items[0]).not.toHaveProperty('email');
      expect(response.json().items[0]).not.toHaveProperty('phone');
      expect(response.json().items[0]).not.toHaveProperty('lastLoginAt');
    },
  );

  it('allows moderators to block users while redacting email from the response', async () => {
    const { app } = await makeApp('MODERATOR');
    const token = app.jwt.sign({ userId: 'acting-admin', role: 'ADMIN', adminRole: 'SUPER_ADMIN' });
    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/users/moderated-user/block',
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'Policy violation' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'moderated-user', name: 'Moderated User', isBlocked: true });
    expect(response.json()).not.toHaveProperty('email');
  });

  it('keeps user blocking unavailable to read-only support staff', async () => {
    const { app, update } = await makeApp('SUPPORT');
    const token = app.jwt.sign({ userId: 'acting-admin', role: 'ADMIN', adminRole: 'SUPER_ADMIN' });
    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/users/moderated-user/block',
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'Policy violation' },
    });

    expect(response.statusCode).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  it.each(['SUPPORT', 'MODERATOR'] as const)(
    'keeps contact details out of quick user search for %s',
    async (adminRole) => {
      const { app, findMany } = await makeApp(adminRole);
      const token = app.jwt.sign({ userId: 'acting-admin', role: 'ADMIN', adminRole: 'SUPER_ADMIN' });
      const response = await app.inject({
        method: 'GET',
        url: '/admin/search/quick?type=users&q=Visible',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()[0]).toEqual({ id: 'visible-user', name: 'Visible User', role: 'USER' });
      const query = findMany.mock.calls.at(-1)?.[0] as { where?: unknown; select?: Record<string, boolean> };
      expect(JSON.stringify(query.where)).not.toContain('email');
      expect(JSON.stringify(query.where)).not.toContain('phone');
      expect(query.select).not.toHaveProperty('email');
      expect(query.select).not.toHaveProperty('phone');
    },
  );

  it.each(['SUPPORT', 'MODERATOR'] as const)(
    'does not permit %s to enumerate staff from the user directory',
    async (adminRole) => {
      const { app } = await makeApp(adminRole);
      const token = app.jwt.sign({ userId: 'acting-admin', role: 'ADMIN', adminRole: 'SUPER_ADMIN' });
      const response = await app.inject({
        method: 'GET',
        url: '/admin/users?isStaff=true',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(403);
    },
  );

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
