import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerNotFoundHandler } from './notFoundHandler';
import { monitorResourceNotFoundProbes, monitorUnmatchedRouteScan } from './unmatched-route-monitor';

describe('unmatched-route scan monitoring', () => {
  const counts = new Map<string, number>();
  const claimedAlerts = new Set<string>();
  const fingerprints = new Map<string, Set<string>>();
  const createAdminNotification = vi.fn(async () => ({ id: 'notice-1' }));
  const warn = vi.fn();
  const error = vi.fn();
  const redis = {
    get: vi.fn(async () => null as string | null),
    eval: vi.fn(async (_script: string, _keyCount: number, key: string) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return count;
    }),
    set: vi.fn(async (
      key: string,
      _value: string,
      _expiryMode: 'EX',
      _seconds: number,
      _condition: 'NX',
    ) => {
      if (claimedAlerts.has(key)) return null;
      claimedAlerts.add(key);
      return 'OK' as const;
    }),
    del: vi.fn(async (key: string) => Number(claimedAlerts.delete(key))),
    sadd: vi.fn(async (key: string, member: string) => {
      const values = fingerprints.get(key) ?? new Set<string>();
      fingerprints.set(key, values);
      const before = values.size;
      values.add(member);
      return Number(values.size > before);
    }),
    scard: vi.fn(async (key: string) => fingerprints.get(key)?.size ?? 0),
    expire: vi.fn(async () => 1),
  };
  const dependencies = { redis, createAdminNotification, warn, error };

  beforeEach(() => {
    counts.clear();
    claimedAlerts.clear();
    fingerprints.clear();
    createAdminNotification.mockReset().mockResolvedValue({ id: 'notice-1' });
    warn.mockReset();
    error.mockReset();
    redis.eval.mockClear();
    redis.set.mockClear();
    redis.del.mockClear();
    redis.sadd.mockClear();
    redis.scard.mockClear();
    redis.expire.mockClear();
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

  it('temporarily restricts only confirmed anonymous scans with high volume and many distinct paths', async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await monitorUnmatchedRouteScan(dependencies, {
        sourceIp: '203.0.113.25',
        routeMatched: false,
        routeFingerprint: `fingerprint-${attempt % 40}`,
        method: 'GET',
        authenticated: false,
        trustedClientIp: true,
        statusCode: 404,
      });
    }

    const restrictionCall = redis.set.mock.calls.find(([key]) =>
      key.startsWith('averon:v1:security:temporary-source-restriction:'),
    );
    expect(restrictionCall).toBeDefined();
    expect(restrictionCall?.[1]).toBe('unmatched-route-scan');
    expect(restrictionCall?.[2]).toBe('EX');
    expect(restrictionCall?.[3]).toBe(600);
    expect(restrictionCall?.[4]).toBe('NX');
    expect(JSON.stringify(restrictionCall)).not.toContain('203.0.113.25');
  });

  it('does not restrict authenticated clients or count browser preflights as route scans', async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await monitorUnmatchedRouteScan(dependencies, {
        sourceIp: '203.0.113.25',
        routeMatched: false,
        routeFingerprint: `authenticated-${attempt % 40}`,
        authenticated: true,
        trustedClientIp: true,
        statusCode: 404,
      });
    }
    await monitorUnmatchedRouteScan(dependencies, {
      sourceIp: '203.0.113.26',
      routeMatched: false,
      routeFingerprint: 'preflight',
      method: 'OPTIONS',
      statusCode: 404,
    });

    expect(redis.set.mock.calls.some(([key]) =>
      key.startsWith('averon:v1:security:temporary-source-restriction:'),
    )).toBe(false);
  });

  it('does not apply an IP restriction unless trusted proxy configuration makes the client IP reliable', async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await monitorUnmatchedRouteScan(dependencies, {
        sourceIp: '203.0.113.25',
        routeMatched: false,
        routeFingerprint: `untrusted-${attempt % 40}`,
        authenticated: false,
        statusCode: 404,
      });
    }

    expect(redis.set.mock.calls.some(([key]) =>
      key.startsWith('averon:v1:security:temporary-source-restriction:'),
    )).toBe(false);
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

  it('restricts anonymous ID enumeration only after many distinct missing IDs and a trusted client IP', async () => {
    for (let attempt = 0; attempt < 110; attempt += 1) {
      await monitorResourceNotFoundProbes(dependencies, {
        sourceIp: '203.0.113.25',
        routeTemplate: '/api/v1/orders/:orderId',
        resourceFingerprint: `hashed-id-${attempt % 50}`,
        method: 'GET',
        authenticated: false,
        trustedClientIp: true,
        statusCode: 404,
      });
    }

    const restrictionCall = redis.set.mock.calls.find(([key]) =>
      key.startsWith('averon:v1:security:temporary-source-restriction:'),
    );
    expect(restrictionCall?.[1]).toBe('resource-id-probe');
    expect(JSON.stringify(restrictionCall)).not.toContain('203.0.113.25');
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
