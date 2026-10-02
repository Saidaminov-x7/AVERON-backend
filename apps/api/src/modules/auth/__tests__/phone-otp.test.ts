import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgresql://127.0.0.1:5432/test';
  process.env.REDIS_URL = 'redis://127.0.0.1:6379';
  process.env.JWT_SECRET = 'test-jwt-secret-with-more-than-32-characters';
  process.env.REFRESH_SECRET = 'test-refresh-secret-with-more-than-32-characters';
  process.env.NODE_ENV = 'test';
  process.env.FEATURE_SMS_VERIFICATION = 'true';
});

import { verifyPhoneOtp } from '../phone-otp';

describe('phone OTP verification', () => {
  it('atomically consumes an OTP attempt in Redis instead of reading and deleting separately', async () => {
    const redis = {
      eval: vi.fn(async (_script: string, _keyCount: number, _key: string, _hash: string) => 1),
      get: vi.fn(),
      del: vi.fn(),
    };
    const app = Fastify();
    app.decorate('redis', redis as never);
    app.post('/phone/verify-code', verifyPhoneOtp);
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/phone/verify-code',
      payload: { phone: '+998 90 123 45 67', code: '123456' },
    });

    expect(response.statusCode).toBe(401);
    expect(redis.eval).toHaveBeenCalledOnce();
    expect(redis.eval.mock.calls[0][0]).toContain("redis.call('DEL', KEYS[1])");
    expect(redis.eval.mock.calls[0][0]).toContain("'KEEPTTL'");
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects expired and exhausted OTP attempts using the atomic Redis result', async () => {
    const redis = {
      eval: vi.fn(async (_script: string, _keyCount: number, _key: string, _hash: string) => 0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(2),
    };
    const app = Fastify();
    app.decorate('redis', redis as never);
    app.post('/phone/verify-code', verifyPhoneOtp);
    await app.ready();

    const expired = await app.inject({
      method: 'POST',
      url: '/phone/verify-code',
      payload: { phone: '+998 90 123 45 67', code: '123456' },
    });
    const exhausted = await app.inject({
      method: 'POST',
      url: '/phone/verify-code',
      payload: { phone: '+998 90 123 45 67', code: '123456' },
    });

    expect(expired.statusCode).toBe(401);
    expect(exhausted.statusCode).toBe(429);
    expect(redis.eval).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
