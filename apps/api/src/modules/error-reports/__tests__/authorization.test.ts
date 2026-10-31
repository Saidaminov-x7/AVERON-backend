import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorReportsModule } from '../index';

const apps: ReturnType<typeof Fastify>[] = [];

async function makeApp(adminRole: 'SUPER_ADMIN' | 'ADMIN' | 'MODERATOR' | 'SUPPORT') {
  const app = Fastify();
  apps.push(app);
  await app.register(fastifyJwt, { secret: 'e'.repeat(64) });
  const findMany = vi.fn(async () => []);
  const count = vi.fn(async () => 0);
  app.decorate('prisma', {
    authSession: { findFirst: vi.fn(async () => ({ id: 'test-session' })) },
    user: {
      findUnique: vi.fn(async () => ({
        id: 'staff-user',
        role: 'ADMIN',
        adminRole,
        isBlocked: false,
        isDeleted: false,
      })),
    },
    clientErrorReport: { findMany, count },
    $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
  } as never);
  await app.register(errorReportsModule, { prefix: '/error-reports' });
  await app.ready();
  const token = app.jwt.sign({ sessionId: 'test-session', userId: 'staff-user', role: 'ADMIN', adminRole: 'SUPER_ADMIN' });
  return { app, token, findMany };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('error report staff policy', () => {
  it('allows support to read reports needed for customer assistance', async () => {
    const { app, token, findMany } = await makeApp('SUPPORT');
    const response = await app.inject({
      method: 'GET',
      url: '/error-reports',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(findMany).toHaveBeenCalledOnce();
  });

  it('does not expose diagnostic reports to moderators', async () => {
    const { app, token, findMany } = await makeApp('MODERATOR');
    const response = await app.inject({
      method: 'GET',
      url: '/error-reports',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    expect(findMany).not.toHaveBeenCalled();
  });
});
