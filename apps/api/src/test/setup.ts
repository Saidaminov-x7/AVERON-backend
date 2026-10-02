// apps/api/src/test/setup.ts

import { beforeAll, afterAll, vi } from 'vitest';

beforeAll(() => {
  // Настройка окружения для тестов
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = globalThis.crypto.randomUUID().replaceAll('-', '').repeat(2);
  process.env.REFRESH_SECRET = globalThis.crypto.randomUUID().replaceAll('-', '').repeat(2);
});

afterAll(() => {
  vi.restoreAllMocks();
});
