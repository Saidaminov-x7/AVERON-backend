import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import { ENUMERATION_ALERT_THRESHOLD, monitorSuccessfulResourceEnumeration } from './successful-resource-enumeration-monitor';

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
    set: vi.fn(async (key: string) => {
      if (alerts.has(key)) return null;
      alerts.add(key);
      return 'OK';
    }),
  };
  const prisma = { auditLog: { create: vi.fn(async () => ({})) }, adminNotification: { create: vi.fn(async () => ({})) } };
  const logger = { warn: vi.fn() };
  return { redis, prisma, logger, keys };
}

describe('successful private-resource enumeration monitoring', () => {
  it('alerts once after distinct successful reads on explicitly monitored private routes', async () => {
    const state = fixture();
    for (let index = 0; index < ENUMERATION_ALERT_THRESHOLD + 1; index += 1) {
      await monitorSuccessfulResourceEnumeration({
        ...state,
        method: 'GET',
        statusCode: 200,
        userId: 'private-user-77',
        routeTemplate: '/api/v1/orders/me/:orderNumber',
        resourceId: `order-${index}`,
      } as never);
    }
    assert.equal(state.prisma.adminNotification.create.mock.calls.length, 1);
    assert.ok(state.keys.every((key) => !key.includes('private-user-77')));
  });

  it('does not require or key on a source IP, avoiding NAT-based cross-account aggregation', async () => {
    const state = fixture();
    await monitorSuccessfulResourceEnumeration({
      ...state,
      method: 'GET',
      statusCode: 200,
      userId: 'private-user-1',
      routeTemplate: '/api/v1/orders/me/:orderNumber',
      resourceId: 'order-1',
    } as never);
    assert.equal(state.redis.eval.mock.calls.length, 1);
    assert.ok(state.keys.every((key) => !key.includes('203.0.113')));
  });

  it('keeps Redis and notification failures out of the successful resource response path', async () => {
    const state = fixture();
    state.redis.eval.mockRejectedValueOnce(new Error('private Redis error detail'));
    await assert.doesNotReject(monitorSuccessfulResourceEnumeration({
      ...state,
      method: 'GET',
      statusCode: 200,
      userId: 'private-user-2',
      routeTemplate: '/api/v1/orders/me/:orderNumber',
      resourceId: 'order-2',
    } as never));
    assert.doesNotMatch(JSON.stringify(state.logger.warn.mock.calls), /private Redis error detail|private-user-2/);
  });
});
