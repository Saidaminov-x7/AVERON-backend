import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { createAuthRateLimitKey } from './rate-limit-key';

const secret = 'unit-test-auth-rate-limit-secret-which-is-long-enough';

describe('createAuthRateLimitKey', () => {
  it('excludes IP, identifiers, and other body fields from storage keys', () => {
    const key = createAuthRateLimitKey(secret, 'login', '203.0.113.7', ['person@example.com', 'must-not-leak']);
    assert.match(key, /^averon:v1:auth:login:[a-f0-9]{64}$/);
    assert.doesNotMatch(key, /203\.0\.113|person|must-not-leak/);
  });

  it('separates route scopes, source addresses, and case-sensitive verification tokens', () => {
    const base = createAuthRateLimitKey(secret, 'verify-2fa', '203.0.113.7', ['TokenCase']);
    assert.notEqual(base, createAuthRateLimitKey(secret, 'login', '203.0.113.7', ['TokenCase']));
    assert.notEqual(base, createAuthRateLimitKey(secret, 'verify-2fa', '203.0.113.8', ['TokenCase']));
    assert.notEqual(base, createAuthRateLimitKey(secret, 'verify-2fa', '203.0.113.7', ['tokencase']));
  });

  it('bounds attacker-controlled identity size and ignores non-string values', () => {
    const oversized = 'x'.repeat(10_000);
    const bounded = createAuthRateLimitKey(secret, 'login', '127.0.0.1', [oversized]);
    const prefixOnly = createAuthRateLimitKey(secret, 'login', '127.0.0.1', [oversized.slice(0, 512)]);
    assert.equal(bounded, prefixOnly);
    assert.equal(createAuthRateLimitKey(secret, 'login', '127.0.0.1', [null]), createAuthRateLimitKey(secret, 'login', '127.0.0.1', ['']));
  });
});
