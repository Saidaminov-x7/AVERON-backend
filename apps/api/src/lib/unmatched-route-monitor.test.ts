import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import { RESOURCE_PROBE_ALERT_THRESHOLD, SCAN_ALERT_THRESHOLD, monitorResourceNotFoundProbes, monitorUnmatchedRouteScan } from './unmatched-route-monitor';
import { TEMPORARY_SOURCE_RESTRICTION_SECONDS } from './temporary-source-restriction';

function fixture() {
  const sets = new Map<string, Set<string>>();
  const alerts = new Set<string>();
  const keys: string[] = [];
  const redis = {
    eval: vi.fn(async (_script: string, _keys: number, key: string, value: string) => {
      keys.push(key);
      const values = sets.get(key) ?? new Set<string>();
      values.add(value);
      sets.set(key, values);
      return values.size;
    }),
    set: vi.fn(async (key: string, _value?: string, _expiry?: string, _seconds?: number, _mode?: string) => {
      if (alerts.has(key)) return null;
      alerts.add(key);
      return 'OK';
    }),
  };
  const prisma = { auditLog: { create: vi.fn(async () => ({})) }, adminNotification: { create: vi.fn(async () => ({})) } };
  const logger = { warn: vi.fn() };
  return { redis, prisma, logger, keys };
}

describe('unknown-route and resource probe monitoring', () => {
  it('ignores matched-route 404s, other statuses, missing sources, and isolated probes', async () => {
    const state = fixture();
    const base = { ...state, statusCode: 404 };
    await monitorUnmatchedRouteScan({ ...base, routeMatched: true, sourceIp: '203.0.113.1', requestPath: '/private' } as never);
    await monitorUnmatchedRouteScan({ ...base, statusCode: 200, routeMatched: false, sourceIp: '203.0.113.1', requestPath: '/private' } as never);
    await monitorUnmatchedRouteScan({ ...base, routeMatched: false, requestPath: '/private' } as never);
    await monitorUnmatchedRouteScan({ ...base, routeMatched: false, sourceIp: '203.0.113.1', requestPath: '/private' } as never);
    assert.equal(state.redis.eval.mock.calls.length, 1);
    assert.equal(state.redis.set.mock.calls.length, 0);
    assert.equal(state.prisma.adminNotification.create.mock.calls.length, 0);
  });

  it('alerts once at the threshold without retaining or exposing the raw source address', async () => {
    const state = fixture();
    for (let index = 0; index < SCAN_ALERT_THRESHOLD + 2; index += 1) {
      await monitorUnmatchedRouteScan({
        ...state,
        statusCode: 404,
        routeMatched: false,
        sourceIp: '198.51.100.25',
        requestPath: `/scan-${index}`,
      } as never);
    }
    assert.equal(state.prisma.adminNotification.create.mock.calls.length, 1);
    assert.ok(state.keys.every((key) => !key.includes('198.51.100.25')));
    assert.ok(state.redis.set.mock.calls.some((call) => call[1] === '1' && call[2] === 'EX' && call[3] === TEMPORARY_SOURCE_RESTRICTION_SECONDS));
    assert.doesNotMatch(JSON.stringify(state.prisma.adminNotification.create.mock.calls), /198\.51\.100/);
  });

  it('alerts on high-volume 404s for a parameterized route without exposing resource IDs', async () => {
    const state = fixture();
    for (let index = 0; index < RESOURCE_PROBE_ALERT_THRESHOLD + 1; index += 1) {
      await monitorResourceNotFoundProbes({
        ...state,
        statusCode: 404,
        routeMatched: true,
        sourceIp: '198.51.100.20',
        routeTemplate: '/api/v1/orders/me/:orderNumber',
        resourceId: `order-secret-${index}`,
      } as never);
    }
    assert.equal(state.prisma.adminNotification.create.mock.calls.length, 1);
    const restrictionKey = state.redis.set.mock.calls.find((call) => call[1] === '1')?.[0];
    assert.ok(restrictionKey?.includes('source-restriction'));
    assert.ok(state.redis.set.mock.calls.some((call) => call[1] === '1' && call[2] === 'EX' && call[3] === TEMPORARY_SOURCE_RESTRICTION_SECONDS));
    assert.doesNotMatch(JSON.stringify(state.prisma.adminNotification.create.mock.calls), /order-secret/);
  });
});
