import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { config } from '../../../config';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgresql://127.0.0.1:5432/test';
  process.env.REDIS_URL = 'redis://127.0.0.1:6379';
  process.env.JWT_SECRET = 'test-jwt-secret-with-more-than-32-characters';
  process.env.REFRESH_SECRET = 'test-refresh-secret-with-more-than-32-characters';
  process.env.NODE_ENV = 'test';
  process.env.FEATURE_SMS_VERIFICATION = 'true';
});

import { requestPhoneOtp, verifyPhoneOtp } from '../phone-otp';
import { smsProvider } from '../../integrations/sms-provider';

describe('phone OTP verification', () => {
  it('stores a hashed OTP under versioned Redis keys and never returns it outside tests', async () => {
    const originalEnvironment = config.NODE_ENV;
    config.NODE_ENV = 'production';
    const send = vi.spyOn(smsProvider, 'send').mockResolvedValue(true);
    const redis = {
      set: vi.fn(async (_key: string, _value: string, ..._options: Array<string | number>) => 'OK'),
      del: vi.fn(),
    };
    const app = Fastify();
    app.decorate('redis', redis as never);
    app.post('/phone/request-code', requestPhoneOtp);
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/phone/request-code',
        payload: { phone: '+998 90 123 45 67' },
      });
      const [cooldownCall, codeCall] = redis.set.mock.calls;
      const stored = JSON.parse(String(codeCall[1])) as { codeHash: string; attempts: number };

      expect(response.statusCode).toBe(200);
      expect(response.json()).not.toHaveProperty('devCode');
      expect(cooldownCall[0]).toBe('averon:v1:auth:phone-otp:cooldown:998901234567');
      expect(codeCall[0]).toBe('averon:v1:auth:phone-otp:code:998901234567');
      expect(stored.codeHash).toMatch(/^[a-f0-9]{64}$/);
      expect(stored.attempts).toBe(0);
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0][0]).toBe('998901234567');
      const sentCode = send.mock.calls[0][1].match(/\d{6}/)?.[0];
      expect(sentCode).toBeDefined();
      expect(stored.codeHash).toBe(createHash('sha256').update(sentCode ?? '').digest('hex'));
      expect(response.body).not.toContain(sentCode);
    } finally {
      config.NODE_ENV = originalEnvironment;
      vi.restoreAllMocks();
      await app.close();
    }
  });

  it('enforces the phone resend cooldown before creating another OTP', async () => {
    const redis = {
      set: vi.fn()
        .mockResolvedValueOnce('OK')
        .mockResolvedValueOnce('OK')
        .mockResolvedValueOnce(null),
      del: vi.fn(),
    };
    const app = Fastify();
    app.decorate('redis', redis as never);
    app.post('/phone/request-code', requestPhoneOtp);
    await app.ready();

    const payload = { phone: '+998 90 123 45 67' };
    const first = await app.inject({ method: 'POST', url: '/phone/request-code', payload });
    const resend = await app.inject({ method: 'POST', url: '/phone/request-code', payload });

    expect(first.statusCode).toBe(200);
    expect(resend.statusCode).toBe(429);
    expect(redis.set).toHaveBeenCalledTimes(3);
    expect(redis.set.mock.calls[2][0]).toBe('averon:v1:auth:phone-otp:cooldown:998901234567');
    await app.close();
  });

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
