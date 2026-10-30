import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL ??= 'postgresql://averon_test:averon_test@127.0.0.1:5432/averon_test';
  process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
  process.env.JWT_SECRET ??= 'test-saved-search-access-secret-32';
  process.env.REFRESH_SECRET ??= 'test-saved-search-refresh-secret-32';
});

import { savedSearchesModule } from './index';

const secret = 'test-saved-search-access-secret-32';

function makeApp(actor: Record<string, unknown>, ownerId: string) {
  const findUser = vi.fn(async () => actor);
  const findSavedSearch = vi.fn(async () => ({ id: 'search-1', userId: ownerId }));
  const deleteSavedSearch = vi.fn(async () => ({ id: 'search-1' }));
  const app = Fastify();
  app.decorate('prisma', {
    authSession: { findFirst: async () => ({ id: 'test-session' }) },
    user: { findUnique: findUser },
    savedSearch: { findUnique: findSavedSearch, delete: deleteSavedSearch },
  } as never);
  return { app, findUser, findSavedSearch, deleteSavedSearch };
}

async function registerRoutes(app: ReturnType<typeof Fastify>) {
  await app.register(fastifyJwt, { secret });
  await app.register(savedSearchesModule, { prefix: '/saved-searches' });
  await app.ready();
}

async function deleteRequest(
  app: ReturnType<typeof Fastify>,
  claims: Record<string, unknown>,
) {
  const token = app.jwt.sign({ ...claims, sessionId: 'test-session' });
  return app.inject({
    method: 'DELETE',
    url: '/saved-searches/search-1',
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('saved-search ownership and admin access', () => {
  it('denies SUPPORT access to another user’s saved search', async () => {
    const { app, deleteSavedSearch } = makeApp({
      id: 'support-1', role: 'ADMIN', adminRole: 'SUPPORT', isBlocked: false, isDeleted: false,
    }, 'customer-1');
    await registerRoutes(app);

    const response = await deleteRequest(app, { userId: 'support-1', role: 'ADMIN', adminRole: 'SUPPORT' });

    expect(response.statusCode).toBe(403);
    expect(deleteSavedSearch).not.toHaveBeenCalled();
    await app.close();
  });

  it('allows SUPPORT to delete only its own saved search', async () => {
    const { app, deleteSavedSearch } = makeApp({
      id: 'support-1', role: 'ADMIN', adminRole: 'SUPPORT', isBlocked: false, isDeleted: false,
    }, 'support-1');
    await registerRoutes(app);

    const response = await deleteRequest(app, { userId: 'support-1', role: 'ADMIN', adminRole: 'SUPPORT' });

    expect(response.statusCode).toBe(204);
    expect(deleteSavedSearch).toHaveBeenCalledOnce();
    await app.close();
  });

  it('preserves cross-user management for a current ADMIN role', async () => {
    const { app, deleteSavedSearch } = makeApp({
      id: 'admin-1', role: 'ADMIN', adminRole: 'ADMIN', isBlocked: false, isDeleted: false,
    }, 'customer-1');
    await registerRoutes(app);

    const response = await deleteRequest(app, { userId: 'admin-1', role: 'ADMIN', adminRole: 'ADMIN' });

    expect(response.statusCode).toBe(204);
    expect(deleteSavedSearch).toHaveBeenCalledOnce();
    await app.close();
  });

  it('uses the current database role rather than a stale privileged token claim', async () => {
    const { app, deleteSavedSearch } = makeApp({
      id: 'demoted-1', role: 'ADMIN', adminRole: 'SUPPORT', isBlocked: false, isDeleted: false,
    }, 'customer-1');
    await registerRoutes(app);

    const response = await deleteRequest(app, { userId: 'demoted-1', role: 'ADMIN', adminRole: 'SUPER_ADMIN' });

    expect(response.statusCode).toBe(403);
    expect(deleteSavedSearch).not.toHaveBeenCalled();
    await app.close();
  });
});
