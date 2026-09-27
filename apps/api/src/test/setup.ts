// apps/api/src/test/setup.ts

import { beforeAll, afterAll, vi } from 'vitest';

beforeAll(() => {
  // Настройка окружения для тестов
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test_secret_key_that_is_at_least_32_characters_long_12345';
});

afterAll(() => {
  vi.restoreAllMocks();
});
