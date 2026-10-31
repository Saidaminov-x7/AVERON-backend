import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { describe, expect, it, vi } from 'vitest';
import { authMiddleware } from './authMiddleware';
import { adminMiddleware } from './adminMiddleware';

const JWT_SECRET = 'test-active-session-secret-that-is-long-enough';

async function buildApp(options: { activeSession: boolean; admin?: boolean }) {
  const findSession = vi.fn().mockResolvedValue(options.activeSession ? { id: 'session-1' } : null);
  const findUser = vi.fn().mockResolvedValue({
    id: 'user-1', role: options.admin ? 'ADMIN' : 'USER', adminRole: options.admin ? 'SUPER_ADMIN' : null,
    isBlocked: false, isDeleted: false,
  });
  const app = Fastify();
  app.decorate('prisma', { authSession: { findFirst: findSession }, user: { findUnique: findUser } } as never);
  await app.register(fastifyJwt, { secret: JWT_SECRET });
  app.get('/private', { preHandler: options.admin ? adminMiddleware : authMiddleware }, async () => ({ ok: true }));
  app.get('/admin', { preHandler: adminMiddleware }, async () => ({ ok: true }));
  const token = app.jwt.sign({ userId: 'user-1', role: options.admin ? 'ADMIN' : 'USER', sessionId: 'session-1' });
  return { app, token, findSession, findUser };
}

describe('revoked access session enforcement', () => {
  it.each([false, true])('rejects revoked JWT sessions for %s admin role', async (admin) => {
    const { app, token, findSession, findUser } = await buildApp({ activeSession: false, admin });
    try {
      const response = await app.inject({ method: 'GET', url: '/private', headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ message: 'Unauthorized' });
      expect(findSession).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'session-1', userId: 'user-1', revokedAt: null, expiresAt: { gt: expect.any(Date) } },
        select: { id: true },
      }));
      expect(findUser).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('allows an active session', async () => {
    const { app, token, findUser } = await buildApp({ activeSession: true });
    try {
      const response = await app.inject({ method: 'GET', url: '/private', headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode).toBe(200);
      expect(findUser).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects legacy access tokens without a revocable session id', async () => {
    const { app, findSession, findUser } = await buildApp({ activeSession: true });
    try {
      const legacyToken = app.jwt.sign({ userId: 'user-1', role: 'USER' });
      const response = await app.inject({ method: 'GET', url: '/private', headers: { authorization: `Bearer ${legacyToken}` } });
      expect(response.statusCode).toBe(401);
      expect(findSession).not.toHaveBeenCalled();
      expect(findUser).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
