import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { monitorSuccessfulResourceEnumeration } from './successful-resource-enumeration-monitor';

describe('successful private-resource enumeration monitoring', () => {
  const members = new Map<string, Set<string>>();
  const alertKeys = new Set<string>();
  const retryCooldowns = new Map<string, number>();
  const createAdminNotification = vi.fn(async (_data: {
    type: string;
    title: string;
    message: string;
    link: string;
  }) => ({ id: 'notice-1' }));
  const warn = vi.fn();
  const error = vi.fn();
  const redis = {
    eval: vi.fn(async (
      _script: string,
      _keyCount: number,
      key: string,
      member: string,
      _ttlSeconds: string,
      _threshold: string,
    ) => {
      const set = members.get(key) ?? new Set<string>();
      set.add(member);
      members.set(key, set);
      return set.size;
    }),
    set: vi.fn(async (key: string) => {
      if (alertKeys.has(key)) return null;
      alertKeys.add(key);
      return 'OK' as const;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      retryCooldowns.set(key, seconds);
      return Number(alertKeys.has(key));
    }),
  };
  const dependencies = { redis, createAdminNotification, warn, error };

  beforeEach(() => {
    members.clear();
    alertKeys.clear();
    retryCooldowns.clear();
    createAdminNotification.mockReset().mockResolvedValue({ id: 'notice-1' });
    warn.mockReset();
    error.mockReset();
    redis.eval.mockClear();
    redis.set.mockClear();
    redis.expire.mockClear();
  });

  it('alerts once after distinct successful reads on explicitly monitored private routes', async () => {
    for (let attempt = 0; attempt < 19; attempt += 1) {
      await monitorSuccessfulResourceEnumeration(dependencies, {
        method: 'GET',
        statusCode: 200,
        userId: 'private-account-42',
        routeTemplate: '/api/v1/orders/me/:orderNumber',
        params: { orderNumber: `ORD-${attempt}` },
      });
    }
    expect(createAdminNotification).not.toHaveBeenCalled();

    await monitorSuccessfulResourceEnumeration(dependencies, {
      method: 'GET',
      statusCode: 200,
      userId: 'private-account-42',
      routeTemplate: '/api/v1/orders/me/:orderNumber',
      params: { orderNumber: 'ORD-19' },
    });
    await monitorSuccessfulResourceEnumeration(dependencies, {
      method: 'GET',
      statusCode: 200,
      userId: 'private-account-42',
      routeTemplate: '/api/v1/orders/me/:orderNumber',
      params: { orderNumber: 'ORD-19' },
    });

    expect(createAdminNotification).toHaveBeenCalledOnce();
    expect(createAdminNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'SECURITY_INCIDENT',
      link: '/audit-log',
      message: expect.stringMatching(/successfully read 20 distinct resources on \/api\/v1\/orders\/me\/:orderNumber/),
    }));
    expect(JSON.stringify(createAdminNotification.mock.calls)).not.toContain('private-account-42');
    expect(JSON.stringify(createAdminNotification.mock.calls)).not.toContain('ORD-19');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-account-42');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('ORD-19');
    expect(redis.eval.mock.calls[0][0]).toContain("redis.call('SADD'");
    expect(redis.eval.mock.calls[0][5]).toBe('20');
  });

  it('uses route-specific thresholds and keeps unrelated or unsuccessful requests out', async () => {
    const common = { userId: 'admin-account', params: { id: 'u-1', orderNumber: 'o-1' } };
    await monitorSuccessfulResourceEnumeration(dependencies, {
      ...common, method: 'POST', statusCode: 200, routeTemplate: '/admin/users/:id',
    });
    await monitorSuccessfulResourceEnumeration(dependencies, {
      ...common, method: 'GET', statusCode: 403, routeTemplate: '/admin/users/:id',
    });
    await monitorSuccessfulResourceEnumeration(dependencies, {
      ...common, method: 'GET', statusCode: 200, routeTemplate: '/api/v1/products/:slug',
    });
    for (let attempt = 0; attempt < 29; attempt += 1) {
      await monitorSuccessfulResourceEnumeration(dependencies, {
        ...common,
        method: 'GET',
        statusCode: 200,
        routeTemplate: '/admin/users/:id',
        params: { id: `user-${attempt}` },
      });
    }

    expect(createAdminNotification).not.toHaveBeenCalled();
    expect(redis.eval).toHaveBeenCalledTimes(29);

    await monitorSuccessfulResourceEnumeration(dependencies, {
      ...common,
      method: 'GET',
      statusCode: 200,
      routeTemplate: '/admin/users/:id',
      params: { id: 'user-29' },
    });
    expect(createAdminNotification).toHaveBeenCalledOnce();
    const notification = createAdminNotification.mock.calls.at(-1)?.[0];
    expect(notification?.message).toMatch(/30 distinct resources/);
  });

  it('does not require or key on a source IP, avoiding NAT-based cross-account aggregation', async () => {
    await monitorSuccessfulResourceEnumeration(dependencies, {
      method: 'GET', statusCode: 200, userId: 'a',
      routeTemplate: '/api/v1/orders/me/:orderNumber', params: { orderNumber: 'ORD-1' },
    });
    await monitorSuccessfulResourceEnumeration(dependencies, {
      method: 'GET', statusCode: 200, userId: 'b',
      routeTemplate: '/api/v1/orders/me/:orderNumber', params: { orderNumber: 'ORD-1' },
    });

    expect(members.size).toBe(2);
    expect([...members.keys()].every((key) => /^averon:v1:security:successful-resource-reads:[a-f0-9]{64}:[a-f0-9]{64}$/.test(key))).toBe(true);
  });

  it('keeps Redis and notification failures out of the successful resource response path and throttles retries', async () => {
    createAdminNotification.mockRejectedValueOnce(new Error('database unavailable'));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await monitorSuccessfulResourceEnumeration(dependencies, {
        method: 'GET',
        statusCode: 200,
        userId: 'private-account-42',
        routeTemplate: '/api/v1/orders/me/:orderNumber',
        params: { orderNumber: `ORD-${attempt}` },
      });
    }
    expect(error).toHaveBeenCalledOnce();
    expect(redis.expire).toHaveBeenCalledOnce();
    expect([...retryCooldowns.values()]).toEqual([60]);
    await monitorSuccessfulResourceEnumeration(dependencies, {
      method: 'GET', statusCode: 200, userId: 'private-account-42',
      routeTemplate: '/api/v1/orders/me/:orderNumber', params: { orderNumber: 'ORD-retry' },
    });
    expect(createAdminNotification).toHaveBeenCalledOnce();

    // Simulate Redis expiring the short cooldown; further abuse can trigger another alert.
    alertKeys.clear();
    await monitorSuccessfulResourceEnumeration(dependencies, {
      method: 'GET', statusCode: 200, userId: 'private-account-42',
      routeTemplate: '/api/v1/orders/me/:orderNumber', params: { orderNumber: 'ORD-retry-2' },
    });
    expect(createAdminNotification).toHaveBeenCalledTimes(2);

    redis.eval.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(monitorSuccessfulResourceEnumeration(dependencies, {
      method: 'GET', statusCode: 200, userId: 'a',
      routeTemplate: '/api/v1/orders/me/:orderNumber', params: { orderNumber: 'ORD-1' },
    })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith({ errorType: 'Error' }, 'Successful-resource monitoring unavailable');
  });

  it('observes only successful reads made through the protected detail endpoint', async () => {
    const app = Fastify();
    app.get<{ Params: { orderNumber: string } }>('/api/v1/orders/me/:orderNumber', async (request) => ({
      order: request.params.orderNumber,
    }));
    app.addHook('onResponse', async (request, reply) => {
      await monitorSuccessfulResourceEnumeration(dependencies, {
        method: request.method,
        statusCode: reply.statusCode,
        userId: 'fixture-owner',
        routeTemplate: request.routeOptions.url,
        params: request.params as Record<string, unknown>,
      });
    });

    try {
      await app.inject({ method: 'GET', url: '/api/v1/orders/me/ORDER-1' });
      await app.inject({ method: 'POST', url: '/api/v1/orders/me/ORDER-2' });
      await app.inject({ method: 'GET', url: '/not-a-private-route' });

      expect(redis.eval).toHaveBeenCalledOnce();
      expect([...members.keys()]).toHaveLength(1);
      expect([...members.values()][0].size).toBe(1);
    } finally {
      await app.close();
    }
  });
});
