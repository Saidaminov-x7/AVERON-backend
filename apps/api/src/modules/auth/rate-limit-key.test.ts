import { describe, expect, it } from 'vitest';
import { createAuthRateLimitKey } from './rate-limit-key';

describe('auth rate-limit Redis keys', () => {
  const secret = 'a-test-only-secret-that-is-long-enough-to-exercise-hmac';

  it('is stable for normalized email casing and excludes IP, identifiers, and other body fields', () => {
    const first = createAuthRateLimitKey(secret, 'login', '203.0.113.9', {
      email: '  Person@Example.test  ',
      password: 'never-store-this-password',
    }, ['email'], true);
    const second = createAuthRateLimitKey(secret, 'login', '203.0.113.9', {
      email: 'person@example.test',
      password: 'different-password',
    }, ['email'], true);

    expect(first).toBe(second);
    expect(first).toMatch(/^auth:login:[a-f0-9]{64}$/);
    for (const sensitiveValue of ['203.0.113.9', 'Person@Example.test', 'never-store-this-password']) {
      expect(first).not.toContain(sensitiveValue);
    }
  });

  it('separates route scopes, source addresses, and case-sensitive verification tokens', () => {
    const create = (scope: string, sourceIp: string, token: string) => createAuthRateLimitKey(
      secret, scope, sourceIp, { tempToken: token }, ['tempToken'],
    );
    const key = create('verify-2fa', '203.0.113.9', 'AbCdEf0123');

    expect(create('verify-2fa', '203.0.113.9', 'AbCdEf0123')).toBe(key);
    expect(create('login', '203.0.113.9', 'AbCdEf0123')).not.toBe(key);
    expect(create('verify-2fa', '203.0.113.10', 'AbCdEf0123')).not.toBe(key);
    expect(create('verify-2fa', '203.0.113.9', 'abcdef0123')).not.toBe(key);
    expect(key).not.toContain('AbCdEf0123');
  });

  it('uses the first non-empty allowed field and safely handles missing or malformed bodies', () => {
    const fallbackPhone = createAuthRateLimitKey(secret, 'register', '127.0.0.1', {
      email: ' ', phone: '+998901234567', password: 'secret',
    }, ['email', 'phone'], true);
    const phoneOnly = createAuthRateLimitKey(secret, 'register', '127.0.0.1', {
      phone: '+998901234567',
    }, ['phone'], true);
    const missingObject = createAuthRateLimitKey(secret, 'register', '127.0.0.1', null, ['email']);
    const missingField = createAuthRateLimitKey(secret, 'register', '127.0.0.1', {}, ['email']);

    expect(fallbackPhone).toBe(phoneOnly);
    expect(missingObject).toBe(missingField);
    expect(missingObject).toMatch(/^auth:register:[a-f0-9]{64}$/);
  });

  it('bounds submitted identity length before normalization and HMAC work', () => {
    const first = createAuthRateLimitKey(secret, 'login', '127.0.0.1', {
      email: 'x'.repeat(257),
    }, ['email'], true);
    const second = createAuthRateLimitKey(secret, 'login', '127.0.0.1', {
      email: 'y'.repeat(100_000),
    }, ['email'], true);

    expect(first).toBe(second);
    expect(first).toMatch(/^auth:login:[a-f0-9]{64}$/);
    expect(first).not.toContain('x'.repeat(257));
  });
});
