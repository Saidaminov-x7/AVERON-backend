import { afterEach, describe, expect, it, vi } from 'vitest';

describe('API host configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('keeps the existing all-interface default for production deployments', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', 'postgresql://averon:secret@127.0.0.1:5432/averon');
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379');
    vi.stubEnv('JWT_SECRET', 'a'.repeat(64));
    vi.stubEnv('REFRESH_SECRET', 'b'.repeat(64));
    vi.stubEnv('PUBLIC_SITE_URL', 'https://averon.uz');
    vi.stubEnv('HOST', '0.0.0.0');

    const { config } = await import('../env');

    expect(config.HOST).toBe('0.0.0.0');
  });

  it('allows a local-only bind for isolated development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DATABASE_URL', 'postgresql://averon_test:secret@127.0.0.1:5432/averon_local_test');
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379/15');
    vi.stubEnv('JWT_SECRET', 'c'.repeat(64));
    vi.stubEnv('REFRESH_SECRET', 'd'.repeat(64));
    vi.stubEnv('HOST', '127.0.0.1');

    const { config } = await import('../env');

    expect(config.HOST).toBe('127.0.0.1');
  });
});
