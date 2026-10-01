import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.RESEND_API_KEY = '';
  process.env.TELEGRAM_BOT_TOKEN = '';
});

import { forgotPasswordHandler, resetPasswordHandler } from '../forgot-password';

const userId = '00000000-0000-4000-8000-000000000001';

describe('password reset security', () => {
  it('does not log or send a password-reset URL through the admin notification path', async () => {
    const redisSet = vi.fn(async (_key: string, ..._args: unknown[]) => 'OK');
    const logInfo = vi.fn();
    const logWarn = vi.fn();
    const request = {
      body: { email: 'person@example.test', locale: 'en' },
      server: {
        prisma: {
          user: {
            findUnique: vi.fn(async () => ({
              id: userId,
              email: 'person@example.test',
              name: 'Test user',
              isBlocked: false,
            })),
          },
        },
        redis: { set: redisSet },
      },
      log: { info: logInfo, warn: logWarn },
    } as never;
    const reply = { send: vi.fn() } as never;

    await forgotPasswordHandler(request, reply);

    const resetToken = String(redisSet.mock.calls[0][0]).replace('pwd_reset:', '');
    expect(resetToken).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(logInfo.mock.calls)).not.toContain(resetToken);
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain(resetToken);
    expect(JSON.stringify(logInfo.mock.calls)).not.toContain('reset-password?token=');
  });

  it('clears the legacy refresh hash and revokes every active auth session in the password-reset transaction', async () => {
    const updatedUser = { id: userId, email: 'person@example.test', name: 'Test user' };
    const userUpdate = vi.fn(async (_args: { data: { passwordHash: string; refreshTokenHash: null } }) => updatedUser);
    const sessionRevoke = vi.fn(async () => ({ count: 2 }));
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      user: { update: userUpdate },
      authSession: { updateMany: sessionRevoke },
    }));
    const request = {
      body: { token: 'valid-reset-token', password: 'StrongPassword123!' },
      server: {
        prisma: {
          $transaction: transaction,
          auditLog: { create: vi.fn(async () => ({})) },
        },
        redis: {
          get: vi.fn(async () => JSON.stringify({ userId, email: 'person@example.test' })),
          del: vi.fn(async () => 1),
        },
      },
      headers: { 'user-agent': 'test-agent' },
      ip: '127.0.0.1',
      log: { info: vi.fn() },
    } as never;
    const reply = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    } as never;

    await resetPasswordHandler(request, reply);

    expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ refreshTokenHash: null }),
    }));
    expect(sessionRevoke).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId, revokedAt: null },
    }));
    expect(transaction).toHaveBeenCalledOnce();
    const updateData = userUpdate.mock.calls[0][0] as { data: { passwordHash: string } };
    expect(updateData.data.passwordHash).toMatch(/^\$argon2/);
  });
});
