import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { viewingRequestsModule } from '../index';

const apps: ReturnType<typeof Fastify>[] = [];

async function makeApp(user: {
  role: string;
  adminRole?: 'SUPER_ADMIN' | 'ADMIN' | 'MODERATOR' | 'SUPPORT' | null;
  isBlocked?: boolean;
  isDeleted?: boolean;
}) {
  const app = Fastify();
  apps.push(app);
  await app.register(fastifyJwt, { secret: 'd'.repeat(64) });
  const findMany = vi.fn(async () => []);
  const findUnique = vi.fn(async () => ({
    id: 'request-id',
    listing: { ownerId: 'another-user' },
  }));
  const update = vi.fn(async () => ({ id: 'request-id', status: 'CONFIRMED' }));
  app.decorate('prisma', {
    authSession: { findFirst: vi.fn(async () => ({ id: 'test-session' })) },
    user: { findUnique: vi.fn(async () => ({
      role: user.role,
      adminRole: user.adminRole ?? null,
      isBlocked: user.isBlocked ?? false,
      isDeleted: user.isDeleted ?? false,
    })) },
    viewingRequest: { findMany, findUnique, update },
  } as never);
  await app.register(viewingRequestsModule, { prefix: '/api/v1' });
  await app.ready();
  const token = app.jwt.sign({ sessionId: 'test-session', userId: 'current-user', role: 'ADMIN' });
  return { app, token, findMany, update };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('viewing request authorization uses current account state', () => {
  it('does not trust a stale ADMIN token after the user is demoted', async () => {
    const { app, token, findMany } = await makeApp({ role: 'USER' });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/viewing-requests',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { listing: { ownerId: 'current-user' } },
    }));
  });

  it('does not let a demoted admin change another owner’s request', async () => {
    const { app, token, update } = await makeApp({ role: 'USER' });
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/viewing-requests/request-id/status',
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'CONFIRMED' },
    });

    expect(response.statusCode).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    { role: 'ADMIN', isBlocked: true },
    { role: 'ADMIN', isDeleted: true },
  ])('rejects inactive accounts from administrative request access', async (user) => {
    const { app, token, findMany } = await makeApp(user);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/viewing-requests',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('keeps the global request queue accessible to an active database admin', async () => {
    const { app, token, findMany } = await makeApp({ role: 'ADMIN' });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/viewing-requests',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(findMany).toHaveBeenCalledWith(expect.not.objectContaining({
      where: { listing: { ownerId: 'current-user' } },
    }));
  });

  it.each(['SUPPORT', 'MODERATOR'] as const)(
    'limits %s staff to requests for their own listings, not the global PII queue',
    async (adminRole) => {
      const { app, token, findMany } = await makeApp({ role: 'ADMIN', adminRole });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/viewing-requests',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { listing: { ownerId: 'current-user' } },
      }));
    },
  );
});
