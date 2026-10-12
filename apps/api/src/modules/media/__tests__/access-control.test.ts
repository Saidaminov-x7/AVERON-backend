import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL ??= 'postgresql://averon_test:averon_test@127.0.0.1:5432/averon_test';
  process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
  process.env.JWT_SECRET ??= 'test-media-access-secret-32-characters';
  process.env.REFRESH_SECRET ??= 'test-media-refresh-secret-32-chars';
});

vi.mock('../storage', () => ({
  createStorageAdapter: () => ({ delete: vi.fn(async () => undefined) }),
}));

import { mediaModule } from '../index';

const secret = 'test-media-access-secret-32-characters';

function makeApp(actor: Record<string, unknown>) {
  const findUser = vi.fn(async () => actor);
  const findMedia = vi.fn(async () => ({ id: 'media-1', ownerId: 'customer-1', url: 'https://storage.invalid/photo.webp' }));
  const countProductImages = vi.fn(async () => 1);
  const deleteMedia = vi.fn(async () => ({ id: 'media-1' }));
  const app = Fastify();
  app.decorate('prisma', {
    user: { findUnique: findUser },
    media: { findUnique: findMedia, delete: deleteMedia },
    commerceProductImage: { count: countProductImages },
  } as never);
  return { app, findUser, findMedia, countProductImages, deleteMedia };
}

async function registerRoutes(app: ReturnType<typeof Fastify>) {
  await app.register(fastifyJwt, { secret });
  await app.register(mediaModule, { prefix: '/media' });
  await app.ready();
}

function token(app: ReturnType<typeof Fastify>, claims: Record<string, unknown>) {
  return app.jwt.sign(claims);
}

describe('media management access control', () => {
  it('requires authentication before listing the media library', async () => {
    const { app, findUser } = makeApp({});
    await registerRoutes(app);

    const response = await app.inject({ method: 'GET', url: '/media' });

    expect(response.statusCode).toBe(401);
    expect(findUser).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not let SUPPORT enumerate the media library', async () => {
    const { app, findUser } = makeApp({
      id: 'support-1', role: 'ADMIN', adminRole: 'SUPPORT', isBlocked: false, isDeleted: false,
    });
    await registerRoutes(app);

    const response = await app.inject({
      method: 'GET',
      url: '/media',
      headers: { authorization: `Bearer ${token(app, { userId: 'support-1', role: 'ADMIN', adminRole: 'SUPER_ADMIN' })}` },
    });

    expect(response.statusCode).toBe(403);
    expect(findUser).toHaveBeenCalledOnce();
    await app.close();
  });

  it('requires an authenticated account for product photo uploads', async () => {
    const { app, findUser } = makeApp({});
    await registerRoutes(app);

    const response = await app.inject({ method: 'POST', url: '/media/upload?purpose=productPhoto' });

    expect(response.statusCode).toBe(401);
    expect(findUser).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not let SUPPORT upload catalog product photos', async () => {
    const { app, findUser } = makeApp({
      id: 'support-1', role: 'ADMIN', adminRole: 'SUPPORT', isBlocked: false, isDeleted: false,
    });
    await registerRoutes(app);

    const response = await app.inject({
      method: 'POST',
      url: '/media/upload?purpose=productPhoto',
      headers: { authorization: `Bearer ${token(app, { userId: 'support-1', role: 'ADMIN', adminRole: 'SUPER_ADMIN' })}` },
    });

    expect(response.statusCode).toBe(403);
    expect(findUser).toHaveBeenCalledOnce();
    await app.close();
  });

  it('does not let SUPPORT delete media owned by another account', async () => {
    const { app, findMedia, countProductImages, deleteMedia } = makeApp({
      id: 'support-1', role: 'ADMIN', adminRole: 'SUPPORT', isBlocked: false, isDeleted: false,
    });
    await registerRoutes(app);

    const response = await app.inject({
      method: 'DELETE',
      url: '/media/media-1',
      headers: { authorization: `Bearer ${token(app, { userId: 'support-1', role: 'ADMIN', adminRole: 'SUPER_ADMIN' })}` },
    });

    expect(response.statusCode).toBe(403);
    expect(findMedia).toHaveBeenCalledOnce();
    expect(countProductImages).not.toHaveBeenCalled();
    expect(deleteMedia).not.toHaveBeenCalled();
    await app.close();
  });

  it('retains SUPER_ADMIN media access while respecting product references', async () => {
    const { app, countProductImages, deleteMedia } = makeApp({
      id: 'super-admin-1', role: 'ADMIN', adminRole: 'SUPER_ADMIN', isBlocked: false, isDeleted: false,
    });
    await registerRoutes(app);

    const response = await app.inject({
      method: 'DELETE',
      url: '/media/media-1',
      headers: { authorization: `Bearer ${token(app, { userId: 'super-admin-1', role: 'ADMIN', adminRole: 'SUPER_ADMIN' })}` },
    });

    expect(response.statusCode).toBe(409);
    expect(countProductImages).toHaveBeenCalledOnce();
    expect(deleteMedia).not.toHaveBeenCalled();
    await app.close();
  });
});
