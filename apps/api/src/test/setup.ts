// apps/api/src/test/setup.ts

import { afterAll, vi } from 'vitest';

// Setup files run before test modules are imported, unlike beforeAll hooks.
// Use isolated local-only endpoints so tests cannot inherit real service URLs.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/averon_test';
process.env.REDIS_URL = 'redis://127.0.0.1:6379/15';
process.env.JWT_SECRET = globalThis.crypto.randomUUID().replaceAll('-', '').repeat(2);
process.env.REFRESH_SECRET = globalThis.crypto.randomUUID().replaceAll('-', '').repeat(2);

afterAll(() => {
  vi.restoreAllMocks();
});
