import { describe, expect, it, vi } from 'vitest';
import {
  createGeminiBudget,
  GEMINI_BUDGET_MODEL,
  type GeminiBudgetRedis,
} from './gemini-budget';

function createMockRedis() {
  const values = new Map<string, number>();
  const evalMock = vi.fn(async (script: string, _keyCount: number, ...args: string[]) => {
    const [aggregateKey, reservationKey, first, second, ttl] = args;
    if (script.includes("local existing = redis.call('GET', KEYS[2]);")) {
      const requested = Number(first);
      const existing = values.get(reservationKey);
      if (existing !== undefined) return existing >= requested ? 2 : 0;
      const current = values.get(aggregateKey) ?? 0;
      if (current + requested > Number(second)) return 0;
      values.set(reservationKey, requested);
      values.set(aggregateKey, current + requested);
      return 1;
    }

    const reserved = values.get(reservationKey);
    if (reserved === undefined) return 0;
    const actual = Number(first);
    if (!Number.isFinite(actual) || actual < 0 || actual > reserved) return 0;
    values.set(aggregateKey, (values.get(aggregateKey) ?? 0) - (reserved - actual));
    values.set(reservationKey, actual);
    void ttl;
    return 1;
  });
  return {
    redis: {
      eval: evalMock,
      info: vi.fn().mockResolvedValue('aof_enabled:1\naof_last_write_status:ok\n'),
      config: vi.fn().mockResolvedValue([
        'appendonly', 'yes', 'appendfsync', 'always', 'maxmemory-policy', 'noeviction',
      ]),
    } as GeminiBudgetRedis,
    evalMock,
    values,
  };
}

describe('Gemini monthly budget reservations', () => {
  it('reserves atomically and rejects the request that would exceed $10', async () => {
    const mock = createMockRedis();
    const budget = createGeminiBudget(mock.redis, GEMINI_BUDGET_MODEL);

    const fullBudget = await budget.reserveGeminiBudget({
      userId: 'u1',
      requestId: 'full',
      estimatedInputTokens: 0,
      maxOutputTokens: 4_000_000,
    });
    const overBudget = await budget.reserveGeminiBudget({
      userId: 'u2',
      requestId: 'one-more-token',
      estimatedInputTokens: 0,
      maxOutputTokens: 1,
    });

    expect(fullBudget).not.toBeNull();
    expect(overBudget).toBeNull();
  });

  it('serializes concurrent reservations through one atomic Redis script', async () => {
    const mock = createMockRedis();
    const budget = createGeminiBudget(mock.redis);
    const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      budget.reserveGeminiBudget({
        userId: `u${index}`,
        requestId: `r${index}`,
        estimatedInputTokens: 0,
        maxOutputTokens: 500_000,
      }),
    ));

    expect(attempts.filter(Boolean)).toHaveLength(8);
    const totalReserved = [...mock.values.entries()]
      .filter(([key]) => key.endsWith(':reserved-units'))
      .reduce((sum, [, value]) => sum + value, 0);
    expect(totalReserved).toBe(100_000_000);
  });

  it('uses UTC month buckets and starts a fresh aggregate after rollover', async () => {
    const mock = createMockRedis();
    let date = new Date('2026-10-31T23:59:59.000Z');
    const budget = createGeminiBudget(mock.redis, GEMINI_BUDGET_MODEL, () => date);
    const october = await budget.reserveGeminiBudget({
      userId: 'u1', requestId: 'october', estimatedInputTokens: 0, maxOutputTokens: 1,
    });
    date = new Date('2026-11-01T00:00:00.000Z');
    const november = await budget.reserveGeminiBudget({
      userId: 'u1', requestId: 'november', estimatedInputTokens: 0, maxOutputTokens: 1,
    });

    expect(october?.reservationId).toContain(':2026-10:');
    expect(november?.reservationId).toContain(':2026-11:');
    expect(mock.evalMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed when Redis cannot confirm the reservation', async () => {
    const redis = {
      eval: vi.fn().mockRejectedValue(new Error('redis unavailable')),
      info: vi.fn().mockResolvedValue('aof_enabled:1\naof_last_write_status:ok\n'),
      config: vi.fn().mockResolvedValue([
        'appendonly', 'yes', 'appendfsync', 'always', 'maxmemory-policy', 'noeviction',
      ]),
    };
    const budget = createGeminiBudget(redis);

    await expect(budget.reserveGeminiBudget({
      userId: 'u1', requestId: 'r1', estimatedInputTokens: 12, maxOutputTokens: 10,
    })).resolves.toBeNull();
  });

  it('fails closed when Redis retention settings cannot be verified', async () => {
    const redis = createMockRedis();
    vi.mocked(redis.redis.config).mockRejectedValueOnce(new Error('CONFIG unavailable'));
    const budget = createGeminiBudget(redis.redis);

    await expect(budget.reserveGeminiBudget({
      userId: 'u1', requestId: 'r1', estimatedInputTokens: 12, maxOutputTokens: 10,
    })).resolves.toBeNull();
    expect(redis.evalMock).not.toHaveBeenCalled();
  });

  it('keeps the full reservation when usage is missing, invalid, or exceeds its bound', async () => {
    const mock = createMockRedis();
    const budget = createGeminiBudget(mock.redis);
    const reserve = await budget.reserveGeminiBudget({
      userId: 'u1', requestId: 'r1', estimatedInputTokens: 100, maxOutputTokens: 20,
    });
    expect(reserve).not.toBeNull();
    const reservedKey = reserve!.reservationId;
    const initialAmount = mock.values.get(reservedKey);

    await budget.settleGeminiBudget({
      reservationId: reservedKey, actualInputTokens: 101, actualOutputTokens: 20,
    });
    await budget.settleGeminiBudget({
      reservationId: reservedKey, actualInputTokens: Number.NaN, actualOutputTokens: 0,
    });

    expect(mock.values.get(reservedKey)).toBe(initialAmount);
  });

  it('reconciles only trusted usage downward and makes retries idempotent', async () => {
    const mock = createMockRedis();
    const budget = createGeminiBudget(mock.redis);
    const request = {
      userId: 'u1', requestId: 'same-request', estimatedInputTokens: 100, maxOutputTokens: 20,
    };
    const first = await budget.reserveGeminiBudget(request);
    const retry = await budget.reserveGeminiBudget(request);
    expect(retry).toEqual(first);

    await budget.settleGeminiBudget({
      reservationId: first!.reservationId, actualInputTokens: 80, actualOutputTokens: 10,
    });
    const remainingReserved = mock.values.get(`ai:gemini:budget:${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}:reserved-units`);
    expect(remainingReserved).toBe(80 * 3 + 10 * 25);
  });

  it('refuses unknown models and unsafe token bounds', async () => {
    const mock = createMockRedis();
    const unknown = createGeminiBudget(mock.redis, 'future-unpriced-model');
    const known = createGeminiBudget(mock.redis);

    await expect(unknown.reserveGeminiBudget({
      userId: 'u1', requestId: 'r1', estimatedInputTokens: 1, maxOutputTokens: 1,
    })).resolves.toBeNull();
    await expect(known.reserveGeminiBudget({
      userId: 'u1', requestId: 'r2', estimatedInputTokens: Number.MAX_SAFE_INTEGER, maxOutputTokens: 1,
    })).resolves.toBeNull();
  });
});
