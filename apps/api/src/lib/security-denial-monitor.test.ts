import { beforeEach, describe, expect, it, vi } from 'vitest';
import { monitorAuthenticatedAuthorizationDenial } from './security-denial-monitor';

describe('authenticated authorization-denial monitoring', () => {
  const countByKey = new Map<string, number>();
  const claimedAlerts = new Set<string>();
  const retryCooldowns = new Map<string, number>();
  const createAdminNotification = vi.fn(async () => ({ id: 'notice-1' }));
  const warn = vi.fn();
  const error = vi.fn();
  const redis = {
    eval: vi.fn(async (_script: string, _keyCount: number, key: string) => {
      const next = (countByKey.get(key) ?? 0) + 1;
      countByKey.set(key, next);
      return next;
    }),
    set: vi.fn(async (key: string) => {
      if (claimedAlerts.has(key)) return null;
      claimedAlerts.add(key);
      return 'OK';
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      retryCooldowns.set(key, seconds);
      return Number(claimedAlerts.has(key));
    }),
  };
  const dependencies = { redis, createAdminNotification, warn, error };

  beforeEach(() => {
    countByKey.clear();
    claimedAlerts.clear();
    retryCooldowns.clear();
    createAdminNotification.mockReset().mockResolvedValue({ id: 'notice-1' });
    warn.mockReset();
    error.mockReset();
    redis.eval.mockClear();
    redis.set.mockClear();
    redis.expire.mockClear();
  });

  it('does not alert for anonymous requests, 401s, or isolated 403 responses', async () => {
    await monitorAuthenticatedAuthorizationDenial(dependencies, { statusCode: 403, route: '/admin/users' });
    await monitorAuthenticatedAuthorizationDenial(dependencies, { userId: 'staff-1', statusCode: 401 });
    for (let attempt = 0; attempt < 11; attempt += 1) {
      await monitorAuthenticatedAuthorizationDenial(dependencies, {
        userId: 'staff-1', statusCode: 403, route: '/admin/users',
      });
    }

    expect(createAdminNotification).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('alerts once after repeated denials without including the raw user ID', async () => {
    for (let attempt = 0; attempt < 13; attempt += 1) {
      await monitorAuthenticatedAuthorizationDenial(dependencies, {
        userId: 'private-user-id', statusCode: 403, route: '/api/v1/admin/users',
      });
    }

    expect(createAdminNotification).toHaveBeenCalledOnce();
    expect(createAdminNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'SECURITY_INCIDENT',
      link: '/audit-log',
      message: expect.stringMatching(/Authenticated account [a-f0-9]{12}/),
    }));
    expect(JSON.stringify(createAdminNotification.mock.calls)).not.toContain('private-user-id');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      route: '/api/v1/admin/users', statusCode: 403, deniedRequests: 12,
    });
  });

  it('applies a short retry cooldown after a failed notification without blocking requests', async () => {
    createAdminNotification.mockRejectedValueOnce(new Error('db unavailable'));

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await monitorAuthenticatedAuthorizationDenial(dependencies, {
        userId: 'staff-2', statusCode: 403, route: '/admin/settings',
      });
    }

    expect(error).toHaveBeenCalledOnce();
    expect(redis.expire).toHaveBeenCalledOnce();
    expect([...retryCooldowns.values()]).toEqual([60]);
    await monitorAuthenticatedAuthorizationDenial(dependencies, {
      userId: 'staff-2', statusCode: 403, route: '/admin/settings',
    });
    expect(createAdminNotification).toHaveBeenCalledOnce();

    // Simulate Redis expiring the short cooldown; the next matching request can retry.
    claimedAlerts.clear();
    await monitorAuthenticatedAuthorizationDenial(dependencies, {
      userId: 'staff-2', statusCode: 403, route: '/admin/settings',
    });
    expect(createAdminNotification).toHaveBeenCalledTimes(2);
  });

  it('fails open and emits only a typed diagnostic if Redis is unavailable', async () => {
    redis.eval.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(monitorAuthenticatedAuthorizationDenial(dependencies, {
      userId: 'staff-3', statusCode: 403, route: '/admin/settings',
    })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith({ errorType: 'Error' }, 'Authorization-denial monitoring unavailable');
    expect(createAdminNotification).not.toHaveBeenCalled();
  });
});
