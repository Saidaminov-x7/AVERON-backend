import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { notificationsModule } from '../notifications';

const apps: ReturnType<typeof Fastify>[] = [];

async function makeApp(adminRole: 'SUPER_ADMIN' | 'ADMIN' | 'MODERATOR' | 'SUPPORT') {
  const app = Fastify();
  apps.push(app);
  await app.register(fastifyJwt, {
    secret: globalThis.crypto.randomUUID().replaceAll('-', '').repeat(2),
  });

  const findUniqueUser = vi.fn(async () => ({
    id: 'acting-admin',
    role: 'ADMIN',
    adminRole,
    isBlocked: false,
    isDeleted: false,
  }));
  const updateNotification = vi.fn(async () => ({
    id: 'targeted-notification',
    targetAdminId: 'another-admin',
    isRead: true,
  }));
  app.decorate('prisma', {
    user: { findUnique: findUniqueUser },
    adminNotification: {
      findUnique: vi.fn(async () => ({
        id: 'targeted-notification',
        targetAdminId: 'another-admin',
        isRead: false,
      })),
      update: updateNotification,
    },
  } as never);
  await app.register(notificationsModule, { prefix: '/admin/notifications' });
  await app.ready();

  return { app, findUniqueUser, updateNotification };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('admin notification ownership authorization', () => {
  it.each(['ADMIN', 'MODERATOR', 'SUPPORT'] as const)(
    "%s cannot mark another admin's targeted notification as read, even with forged SUPER_ADMIN claims",
    async (adminRole) => {
      const { app, updateNotification } = await makeApp(adminRole);
      const token = app.jwt.sign({
        userId: 'acting-admin',
        role: 'ADMIN',
        adminRole: 'SUPER_ADMIN',
      });

      const response = await app.inject({
        method: 'PATCH',
        url: '/admin/notifications/targeted-notification/read',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(403);
      expect(updateNotification).not.toHaveBeenCalled();
    },
  );

  it("allows a current database SUPER_ADMIN to mark another admin's targeted notification as read", async () => {
    const { app, updateNotification } = await makeApp('SUPER_ADMIN');
    const token = app.jwt.sign({
      userId: 'acting-admin',
      role: 'CUSTOMER',
      adminRole: 'SUPPORT',
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/notifications/targeted-notification/read',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(updateNotification).toHaveBeenCalledOnce();
  });
});
