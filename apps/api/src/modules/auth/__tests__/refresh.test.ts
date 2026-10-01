import Fastify from 'fastify';
import { fastifyCookie } from '@fastify/cookie';
import argon2 from 'argon2';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyRefreshToken } from '../../../lib/jwt';
import { refreshHandler } from '../refresh';

vi.mock('../../../lib/jwt', () => ({
  generateTokens: vi.fn(),
  verifyRefreshToken: vi.fn(),
}));
vi.mock('argon2', () => ({
  default: { hash: vi.fn(), verify: vi.fn() },
}));
vi.mock('../sessions', () => ({ saveAuthSession: vi.fn() }));

describe('refresh session validation', () => {
  beforeEach(() => {
    vi.mocked(verifyRefreshToken).mockReset();
    vi.mocked(argon2.verify).mockReset();
  });

  it('rejects a revoked or missing per-device session without falling back to the user hash', async () => {
    vi.mocked(verifyRefreshToken).mockReturnValue({
      userId: 'user-id',
      sessionId: 'revoked-session',
    });
    const app = Fastify();
    const user = {
      id: 'user-id',
      role: 'USER',
      adminRole: null,
      isBlocked: false,
      isDeleted: false,
      refreshTokenHash: 'global-hash-for-this-same-token',
    };
    const prisma = {
      user: {
        findUnique: vi.fn(async () => user),
        update: vi.fn(),
      },
      authSession: { findFirst: vi.fn(async () => null) },
    };
    app.decorate('prisma', prisma as never);
    app.decorate('redis', { get: vi.fn(async () => null) } as never);
    await app.register(fastifyCookie);
    app.post('/auth/refresh', refreshHandler);
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: 'refreshToken=opaque-refresh-token' },
    });

    expect(response.statusCode).toBe(401);
    expect(prisma.authSession.findFirst).toHaveBeenCalledOnce();
    expect(argon2.verify).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    await app.close();
  });
});
