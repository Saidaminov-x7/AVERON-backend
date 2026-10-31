import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import { DENIAL_ALERT_THRESHOLD, monitorAuthenticatedAuthorizationDenial } from './security-denial-monitor';

function fixture(initial = 0) {
  let count = initial;
  const keys: string[] = [];
  const alerts = new Set<string>();
  const redis = {
    eval: vi.fn(async (_script: string, _keys: number, key: string) => {
      keys.push(key);
      return ++count;
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

describe('authorization denial monitoring', () => {
  it('does not alert for anonymous requests, 401s, or isolated 403 responses', async () => {
    const state = fixture();
    await monitorAuthenticatedAuthorizationDenial({ ...state, statusCode: 401, userId: 'user-1', routeTemplate: '/admin/users/:id' } as never);
    await monitorAuthenticatedAuthorizationDenial({ ...state, statusCode: 403, routeTemplate: '/admin/users/:id' } as never);
    await monitorAuthenticatedAuthorizationDenial({ ...state, statusCode: 403, userId: 'user-1', routeTemplate: '/admin/users/:id' } as never);
    assert.equal(state.redis.eval.mock.calls.length, 1);
    assert.equal(state.prisma.adminNotification.create.mock.calls.length, 0);
  });

  it('alerts once after repeated denials without including the raw user ID', async () => {
    const state = fixture(DENIAL_ALERT_THRESHOLD - 2);
    const input = { ...state, statusCode: 403, userId: 'private-user-42', routeTemplate: '/admin/users/:id' } as never;
    await monitorAuthenticatedAuthorizationDenial(input);
    await monitorAuthenticatedAuthorizationDenial(input);
    await monitorAuthenticatedAuthorizationDenial(input);
    assert.equal(state.prisma.adminNotification.create.mock.calls.length, 1);
    assert.ok(state.keys.every((key) => !key.includes('private-user-42')));
    assert.doesNotMatch(JSON.stringify(state.prisma.adminNotification.create.mock.calls), /private-user-42/);
  });

  it('fails open and emits only a typed diagnostic if Redis is unavailable', async () => {
    const state = fixture();
    state.redis.eval.mockRejectedValueOnce(new Error('secret Redis detail'));
    await assert.doesNotReject(monitorAuthenticatedAuthorizationDenial({ ...state, statusCode: 403, userId: 'user-1', routeTemplate: '/admin/users/:id' } as never));
    assert.deepEqual(state.logger.warn.mock.calls[0]?.[0], { event: 'security_monitor_unavailable', category: 'AUTHORIZATION_DENIALS' });
    assert.doesNotMatch(JSON.stringify(state.logger.warn.mock.calls), /secret Redis detail|user-1/);
  });
});
