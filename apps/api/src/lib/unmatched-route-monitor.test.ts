import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerNotFoundHandler } from './notFoundHandler';
import { monitorResourceNotFoundProbes, monitorUnmatchedRouteScan } from './unmatched-route-monitor';

describe('unmatched-route scan monitoring', () => {
  const counts = new Map<string, number>();
  const claimedAlerts = new Set<string>();
  const createAdminNotification = vi.fn(async () => ({ id: 'notice-1' }));
  const warn = vi.fn();
  const error = vi.fn();
  const redis = {
    eval: vi.fn(async (_script: string, _keyCount: number, key: string) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return count;
    }),
    set: vi.fn(async (key: string) => {
      if (claimedAlerts.has(key)) return null;
      claimedAlerts.add(key);
      return 'OK' as const;
    }),
    del: vi.fn(async (key: string) => Number(claimedAlerts.delete(key))),
  };
  const dependencies = { redis, createAdminNotification, warn, error };

  beforeEach(() => {
    counts.clear();
    claimedAlerts.clear();
    createAdminNotification.mockReset().mockResolvedValue({ id: 'notice-1' });
    warn.mockReset();
    error.mockReset();
    redis.eval.mockClear();
    redis.set.mockClear();
    redis.del.mockClear();
  });

  it('ignores matched-route 404s, other statuses, missing sources, and isolated probes', async () => {
    await monitorUnmatchedRouteScan(dependencies, { sourceIp: '203.0.113.5', routeMatched: true, statusCode: 404 });
    await monitorUnmatchedRouteScan(dependencies, { sourceIp: '203.0.113.5', routeMatched: false, statusCode: 200 });
    await monitorUnmatchedRouteScan(dependencies, { routeMatched: false, statusCode: 404 });
    for (let attempt = 0; attempt < 39; attempt += 1) {
      await monitorUnmatchedRouteScan(dependencies, {
        sourceIp: '203.0.113.5', routeMatched: false, statusCode: 404,
      });
    }

    expect(createAdminNotification).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('counts only requests that Fastify did not match to a route', async () => {
    const app = Fastify();
    app.get('/known-resource/:id', async (_request, reply) => reply.status(404).send());
    app.addHook('onResponse', async (request, reply) => {
      await monitorUnmatchedRouteScan(dependencies, {
        sourceIp: request.ip,
        routeMatched: Boolean(request.routeOptions.url),
        statusCode: reply.statusCode,
      });
    });
    registerNotFoundHandler(app);

    try {
      await app.inject({ method: 'GET', url: '/unmatched-probe' });
      await app.inject({ method: 'GET', url: '/known-resource/123' });

      expect(redis.eval).toHaveBeenCalledOnce();
      expect([...counts.keys()]).toHaveLength(1);
      expect([...counts.keys()][0]).toMatch(/^averon:v1:security:unmatched-routes:[a-f0-9]{64}$/);
    } finally {
      await app.close();
    }
  });

  it('alerts once at the threshold without retaining or exposing the raw source address', async () => {
    for (let attempt = 0; attempt < 45; attempt += 1) {
      await monitorUnmatchedRouteScan(dependencies, {
        sourceIp: '203.0.113.25', routeMatched: false, statusCode: 404,
      });
    }

    expect(createAdminNotification).toHaveBeenCalledOnce();
    expect(createAdminNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'SECURITY_INCIDENT',
      link: '/audit-log',
      message: expect.stringMatching(/Network source [a-f0-9]{12} received 40 unmatched-route 404 responses/),
    }));
    expect(JSON.stringify(createAdminNotification.mock.calls)).not.toContain('203.0.113.25');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('203.0.113.25');
    expect(warn).toHaveBeenCalledOnce();
    expect(redis.set).toHaveBeenCalled();
  });

  it('keeps monitoring failures off the request path and permits alert retry after notification failure', async () => {
    createAdminNotification.mockRejectedValueOnce(new Error('database unavailable'));
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await monitorUnmatchedRouteScan(dependencies, {
        sourceIp: '203.0.113.25', routeMatched: false, statusCode: 404,
      });
    }

    expect(error).toHaveBeenCalledOnce();
    expect(redis.del).toHaveBeenCalledOnce();
    await monitorUnmatchedRouteScan(dependencies, {
      sourceIp: '203.0.113.25', routeMatched: false, statusCode: 404,
    });
    expect(createAdminNotification).toHaveBeenCalledTimes(2);

    redis.eval.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(monitorUnmatchedRouteScan(dependencies, {
      sourceIp: '203.0.113.25', routeMatched: false, statusCode: 404,
    })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith({ errorType: 'Error' }, 'Unmatched-route monitoring unavailable');
  });

  it('alerts on high-volume 404s for a parameterized route without exposing resource IDs', async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await monitorResourceNotFoundProbes(dependencies, {
        sourceIp: '203.0.113.25', routeTemplate: '/api/v1/orders/:orderId', statusCode: 404,
      });
    }

    expect(createAdminNotification).toHaveBeenCalledOnce();
    expect(createAdminNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'SECURITY_INCIDENT',
      message: expect.stringMatching(/received 60 resource-not-found responses on \/api\/v1\/orders\/:orderId/),
    }));
    expect(JSON.stringify(createAdminNotification.mock.calls)).not.toContain('203.0.113.25');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('203.0.113.25');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('ignores isolated, non-404, and non-parameterized resource misses', async () => {
    await monitorResourceNotFoundProbes(dependencies, {
      sourceIp: '203.0.113.25', routeTemplate: '/api/v1/orders', statusCode: 404,
    });
    await monitorResourceNotFoundProbes(dependencies, {
      sourceIp: '203.0.113.25', routeTemplate: '/api/v1/orders/:orderId', statusCode: 200,
    });
    for (let attempt = 0; attempt < 59; attempt += 1) {
      await monitorResourceNotFoundProbes(dependencies, {
        sourceIp: '203.0.113.25', routeTemplate: '/api/v1/orders/:orderId', statusCode: 404,
      });
    }

    expect(createAdminNotification).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
