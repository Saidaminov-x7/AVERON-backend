import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

export const LOGIN_FAILURE_LIMIT = 8;
export const LOGIN_FAILURE_TTL_SECONDS = 15 * 60;

export function loginFailureKey(identifierType: 'email' | 'phone', identifier: string) {
  const normalized = identifier.trim().toLowerCase();
  const digest = createHash('sha256').update(`${identifierType}:${normalized}`).digest('hex');
  return `averon:v1:auth:login-failures:${digest}`;
}

export async function isLoginTemporarilyLocked(redis: Redis, key: string) {
  const failures = Number(await redis.get(key) ?? 0);
  return failures >= LOGIN_FAILURE_LIMIT;
}

export async function recordLoginFailure(redis: Redis, key: string) {
  await redis.eval(
    "local attempts = redis.call('INCR', KEYS[1]); " +
      "if attempts == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; " +
      'return attempts',
    1,
    key,
    String(LOGIN_FAILURE_TTL_SECONDS),
  );
}

export async function clearLoginFailures(redis: Redis, key: string) {
  await redis.del(key);
}
