import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { describe, expect, it, vi } from 'vitest';
import { adminModule } from './index';

const JWT_SECRET = 'test-webhooks-access-secret-that-is-long-enough';
const storedWebhook = {
  id: 'webhook-1',
  name: 'CRM',
  url: 'https://hooks.example.com/events',
  events: ['ORDER_CREATED'],
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  secret: 'never-return-this-signing-secret',
};

function selectedWebhook(select: Record<string, boolean>) {
  return Object.fromEntries(Object.keys(select).map((field) => [field, storedWebhook[field as keyof typeof storedWebhook]]));
}

async function makeApp() {
  const findMany = vi.fn(async ({ select }: { select: Record<string, boolean> }) => [selectedWebhook(select)]);
  const create = vi.fn(async ({ data, select }: { data: Record<string, unknown>; select: Record<string, boolean> }) => ({
    ...selectedWebhook(select), secret: data.secret,
  }));
  const app = Fastify();
  app.decorate('prisma', {
    authSession: { findFirst: async () => ({ id: 'test-session' }) },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'admin-1', role: 'ADMIN', adminRole: 'SUPER_ADMIN', isBlocked: false, isDeleted: false,
      }),
    },
    systemWebhook: { findMany, create },
  } as never);
  await app.register(fastifyJwt, { secret: JWT_SECRET });
  await app.register(adminModule, { prefix: '/admin' });
  await app.ready();
  return { app, findMany, create };
}

describe('admin webhook signing secret response security', () => {
  it('omits stored secrets from the webhook list response', async () => {
    const { app, findMany } = await makeApp();
    try {
      const token = app.jwt.sign({ userId: 'admin-1', role: 'ADMIN', adminRole: 'SUPER_ADMIN', sessionId: 'test-session' });
      const response = await app.inject({
        method: 'GET', url: '/admin/webhooks', headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()[0]).not.toHaveProperty('secret');
      expect(findMany).toHaveBeenCalledWith({
        orderBy: { createdAt: 'desc' },
        select: expect.objectContaining({ id: true, name: true, url: true, isActive: true }),
      });
      expect(findMany.mock.calls[0][0].select).not.toHaveProperty('secret');
    } finally {
      await app.close();
    }
  });

  it('stores a submitted secret without echoing it in the create response', async () => {
    const { app, create } = await makeApp();
    try {
      const token = app.jwt.sign({ userId: 'admin-1', role: 'ADMIN', adminRole: 'SUPER_ADMIN', sessionId: 'test-session' });
      const response = await app.inject({
        method: 'POST',
        url: '/admin/webhooks',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'CRM', url: storedWebhook.url, events: storedWebhook.events, secret: storedWebhook.secret },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ success: true });
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ secret: storedWebhook.secret }),
        select: expect.objectContaining({ id: true, name: true, url: true, isActive: true }),
      }));
      expect(create.mock.calls[0][0].select).not.toHaveProperty('secret');
    } finally {
      await app.close();
    }
  });
});
