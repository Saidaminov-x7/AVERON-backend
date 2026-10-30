import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL ??= 'postgresql://averon_test:averon_test@127.0.0.1:5432/averon_test';
  process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
  process.env.JWT_SECRET ??= 'test-admin-notifications-access-secret';
  process.env.REFRESH_SECRET ??= 'test-admin-notifications-refresh-secret';
});

import { notificationsModule } from './notifications';

const secret = 'test-admin-notifications-access-secret';

function makeApp(adminRole = 'SUPPORT') {
  const findUser = vi.fn(async () => ({
    id: 'admin-recipient',
    role: 'ADMIN',
    adminRole,
    isBlocked: false,
    isDeleted: false,
  }));
  const findNotification = vi.fn(async () => ({
    id: 'notification-for-another-admin',
    targetAdminId: 'admin-owner',
    isRead: false,
  }));
  const updateNotification = vi.fn(async () => ({
    id: 'notification-for-another-admin',
    targetAdminId: 'admin-owner',
    isRead: true,
  }));
  const findNotifications = vi.fn(async () => []);
  const countNotifications = vi.fn(async () => 0);

  const app = Fastify();
  app.decorate('prisma', {
    authSession: { findFirst: async () => ({ id: 'test-session' }) },
    user: { findUnique: findUser },
    adminNotification: {
      findMany: findNotifications,
      count: countNotifications,
      findUnique: findNotification,
      update: updateNotification,
    },
  } as never);

  return { app, findUser, findNotification, updateNotification, findNotifications, countNotifications };
}

async function registerRoutes(app: ReturnType<typeof Fastify>) {
  await app.register(fastifyJwt, { secret });
  await app.register(notificationsModule, { prefix: '/admin/notifications' });
  await app.ready();
}

describe('admin notification API access control', () => {
  it('limits notification listings to shared and current-admin notifications', async () => {
    const { app, findNotifications, countNotifications } = makeApp();
    await registerRoutes(app);
    const token = app.jwt.sign({ userId: 'admin-recipient', role: 'ADMIN', adminRole: 'SUPPORT', sessionId: 'test-session' });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/notifications?all=1',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const ownerFilter = { OR: [{ targetAdminId: null }, { targetAdminId: 'admin-recipient' }] };
    expect(findNotifications).toHaveBeenCalledWith(expect.objectContaining({
      where: ownerFilter,
      orderBy: { createdAt: 'desc' },
      take: 30,
    }));
    expect(countNotifications).toHaveBeenCalledWith({ where: { ...ownerFilter, isRead: false } });
    await app.close();
  });

  it('requires authentication before looking up an admin notification', async () => {
    const { app, findUser, findNotification } = makeApp();
    await registerRoutes(app);

    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/notifications/notification-for-another-admin/read',
    });

    expect(response.statusCode).toBe(401);
    expect(findUser).not.toHaveBeenCalled();
    expect(findNotification).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not let an admin mark another admin’s private notification as read', async () => {
    const { app, findUser, findNotification, updateNotification } = makeApp();
    await registerRoutes(app);
    const token = app.jwt.sign({ userId: 'admin-recipient', role: 'ADMIN', adminRole: 'SUPPORT', sessionId: 'test-session' });

    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/notifications/notification-for-another-admin/read',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    expect(findUser).toHaveBeenCalledOnce();
    expect(findNotification).toHaveBeenCalledOnce();
    expect(updateNotification).not.toHaveBeenCalled();
    await app.close();
  });

  it('preserves the explicit super-admin override for another admin’s notification', async () => {
    const { app, updateNotification } = makeApp('SUPER_ADMIN');
    await registerRoutes(app);
    const token = app.jwt.sign({ userId: 'admin-recipient', role: 'ADMIN', adminRole: 'SUPER_ADMIN', sessionId: 'test-session' });

    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/notifications/notification-for-another-admin/read',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(updateNotification).toHaveBeenCalledWith({
      where: { id: 'notification-for-another-admin' },
      data: { isRead: true },
    });
    await app.close();
  });
});
