import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import { isSourceTemporarilyRestricted, restrictSourceTemporarily, TEMPORARY_SOURCE_RESTRICTION_SECONDS, temporarySourceRestrictionKey } from './temporary-source-restriction';

describe('temporary source restrictions', () => {
  it('hashes source and route scope and sets a finite ten-minute TTL', async () => {
    const blocked = new Set<string>();
    const redis = {
      set: vi.fn(async (key: string) => { blocked.add(key); return 'OK'; }),
      get: vi.fn(async (key: string) => blocked.has(key) ? '1' : null),
    };
    const key = temporarySourceRestrictionKey('203.0.113.1', '/api/v1/orders/me/:orderNumber');
    assert.match(key, /^averon:v1:security:source-restriction:[a-f0-9]{64}:[a-f0-9]{64}$/);
    assert.doesNotMatch(key, /203\.0\.113|orderNumber/);
    await restrictSourceTemporarily(redis as never, '203.0.113.1', '/api/v1/orders/me/:orderNumber');
    assert.deepEqual(redis.set.mock.calls[0], [key, '1', 'EX', TEMPORARY_SOURCE_RESTRICTION_SECONDS, 'NX']);
    assert.equal(await isSourceTemporarilyRestricted(redis as never, '203.0.113.1', '/api/v1/orders/me/:orderNumber'), true);
    assert.equal(await isSourceTemporarilyRestricted(redis as never, '203.0.113.1', '/api/v1/admin/orders/:orderNumber'), false);
  });

  it('fails open when Redis is unavailable', async () => {
    const redis = { set: vi.fn(async () => { throw new Error('private redis endpoint'); }), get: vi.fn(async () => { throw new Error('private redis endpoint'); }) };
    const logger = { warn: vi.fn() };
    await assert.doesNotReject(restrictSourceTemporarily(redis as never, '203.0.113.1', '/unmatched', logger as never));
    assert.equal(await isSourceTemporarilyRestricted(redis as never, '203.0.113.1', '/unmatched', logger as never), false);
    assert.equal(logger.warn.mock.calls.length, 2);
    assert.doesNotMatch(JSON.stringify(logger.warn.mock.calls), /private redis endpoint/);
  });
});
