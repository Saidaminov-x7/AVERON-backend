import { describe, expect, it, vi } from 'vitest';
import type { ExchangeRateProvider } from '../contracts';
import { CurrencyRateError, CurrencyRateService } from '../currency-rate';

function createCache() {
  const values = new Map<string, string>();
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
      return 'OK';
    }),
  };
}

function provider(getRate: ExchangeRateProvider['getRate'] = vi.fn(async () => ({
  rate: 1850.25,
  providerTimestamp: '2026-10-02T11:00:00.000Z',
}))): ExchangeRateProvider {
  return { id: 'test-provider', getRate };
}

describe('currency rate service', () => {
  it('caches provider-sourced rates with freshness metadata and explicit TTLs', async () => {
    const cache = createCache();
    const getRate = vi.fn(async () => ({ rate: 1850.25, providerTimestamp: '2026-10-02T11:00:00.000Z' }));
    const service = new CurrencyRateService({
      provider: provider(getRate),
      cache,
      now: () => new Date('2026-10-02T11:05:00.000Z'),
      ttlSeconds: 60,
      staleTtlSeconds: 600,
    });

    const first = await service.getRate();
    const second = await service.getRate();

    expect(first).toEqual({
      baseCurrency: 'CNY',
      quoteCurrency: 'UZS',
      rate: 1850.25,
      provider: 'test-provider',
      providerTimestamp: '2026-10-02T11:00:00.000Z',
      fetchedAt: '2026-10-02T11:05:00.000Z',
      stale: false,
    });
    expect(second).toEqual(first);
    expect(getRate).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenNthCalledWith(
      1,
      'averon:v1:currency:CNY:UZS:fresh',
      expect.any(String),
      'EX',
      60,
    );
    expect(cache.set).toHaveBeenNthCalledWith(
      2,
      'averon:v1:currency:CNY:UZS:last-known',
      expect.any(String),
      'EX',
      600,
    );
  });

  it('never invents a rate when no provider is registered', async () => {
    const service = new CurrencyRateService({ provider: null, cache: createCache() });
    await expect(service.getRate()).rejects.toMatchObject({ code: 'CURRENCY_NOT_CONFIGURED' });
  });

  it('uses last-known data only when both request and business policy explicitly allow stale data', async () => {
    const cache = createCache();
    const seed = new CurrencyRateService({
      provider: provider(),
      cache,
      now: () => new Date('2026-10-02T11:05:00.000Z'),
    });
    await seed.getRate();
    cache.values.delete('averon:v1:currency:CNY:UZS:fresh');
    const unavailable = provider(vi.fn(async () => {
      throw new Error('provider unavailable');
    }));

    const strict = new CurrencyRateService({ provider: unavailable, cache, allowStaleOnProviderFailure: false });
    await expect(strict.getRate({ allowStale: true })).rejects.toMatchObject({
      code: 'CURRENCY_PROVIDER_UNAVAILABLE',
    });

    const allowStale = new CurrencyRateService({ provider: unavailable, cache, allowStaleOnProviderFailure: true });
    await expect(allowStale.getRate({ allowStale: true })).resolves.toMatchObject({
      rate: 1850.25,
      stale: true,
    });
  });

  it('rejects and does not cache invalid provider rates', async () => {
    const cache = createCache();
    const service = new CurrencyRateService({
      provider: provider(vi.fn(async () => ({ rate: Number.NaN, providerTimestamp: null }))),
      cache,
    });
    await expect(service.getRate()).rejects.toBeInstanceOf(CurrencyRateError);
    expect(cache.set).not.toHaveBeenCalled();
  });
});
