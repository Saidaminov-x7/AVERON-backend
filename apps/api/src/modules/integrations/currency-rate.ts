import type { ExchangeRateProvider } from './contracts';

const CURRENCY_CACHE_PREFIX = 'averon:v1:currency';

export type CurrencyRate = {
  baseCurrency: 'CNY';
  quoteCurrency: 'UZS';
  rate: number;
  provider: string;
  providerTimestamp: string | null;
  fetchedAt: string;
  stale: boolean;
};

type RateCache = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expirationMode: 'EX', ttlSeconds: number): Promise<unknown>;
};

type CachedCurrencyRate = Omit<CurrencyRate, 'stale'>;

type CurrencyRateServiceOptions = {
  provider: ExchangeRateProvider | null;
  cache: RateCache;
  now?: () => Date;
  ttlSeconds?: number;
  staleTtlSeconds?: number;
  allowStaleOnProviderFailure?: boolean;
};

export class CurrencyRateError extends Error {
  constructor(readonly code: 'CURRENCY_NOT_CONFIGURED' | 'CURRENCY_PROVIDER_UNAVAILABLE' | 'CURRENCY_RATE_INVALID') {
    super(code);
    this.name = 'CurrencyRateError';
  }
}

function parseCachedRate(value: string | null): CachedCurrencyRate | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (record.baseCurrency !== 'CNY' || record.quoteCurrency !== 'UZS'
      || typeof record.rate !== 'number' || !Number.isFinite(record.rate) || record.rate <= 0
      || typeof record.provider !== 'string' || !record.provider
      || (record.providerTimestamp !== null && typeof record.providerTimestamp !== 'string')
      || typeof record.fetchedAt !== 'string' || !Number.isFinite(Date.parse(record.fetchedAt))) return null;
    return record as CachedCurrencyRate;
  } catch {
    return null;
  }
}

export class CurrencyRateService {
  private readonly ttlSeconds: number;
  private readonly staleTtlSeconds: number;

  constructor(private readonly options: CurrencyRateServiceOptions) {
    this.ttlSeconds = options.ttlSeconds ?? 1800;
    this.staleTtlSeconds = options.staleTtlSeconds ?? 7 * 24 * 60 * 60;
    if (!Number.isInteger(this.ttlSeconds) || this.ttlSeconds < 1
      || !Number.isInteger(this.staleTtlSeconds) || this.staleTtlSeconds < this.ttlSeconds) {
      throw new Error('CURRENCY_CACHE_TTL_INVALID');
    }
  }

  async getRate(options: { allowStale?: boolean } = {}): Promise<CurrencyRate> {
    if (!this.options.provider) throw new CurrencyRateError('CURRENCY_NOT_CONFIGURED');
    const freshKey = `${CURRENCY_CACHE_PREFIX}:CNY:UZS:fresh`;
    const staleKey = `${CURRENCY_CACHE_PREFIX}:CNY:UZS:last-known`;
    const fresh = parseCachedRate(await this.options.cache.get(freshKey));
    if (fresh) return { ...fresh, stale: false };

    const lastKnown = parseCachedRate(await this.options.cache.get(staleKey));
    try {
      const quote = await this.options.provider.getRate('CNY', 'UZS');
      if (!Number.isFinite(quote.rate) || quote.rate <= 0
        || (quote.providerTimestamp !== null && !Number.isFinite(Date.parse(quote.providerTimestamp)))) {
        throw new CurrencyRateError('CURRENCY_RATE_INVALID');
      }
      const value: CachedCurrencyRate = {
        baseCurrency: 'CNY',
        quoteCurrency: 'UZS',
        rate: quote.rate,
        provider: this.options.provider.id,
        providerTimestamp: quote.providerTimestamp,
        fetchedAt: (this.options.now?.() ?? new Date()).toISOString(),
      };
      const serialized = JSON.stringify(value);
      await this.options.cache.set(freshKey, serialized, 'EX', this.ttlSeconds);
      await this.options.cache.set(staleKey, serialized, 'EX', this.staleTtlSeconds);
      return { ...value, stale: false };
    } catch (error) {
      if (error instanceof CurrencyRateError && error.code === 'CURRENCY_RATE_INVALID') throw error;
      if (options.allowStale === true && this.options.allowStaleOnProviderFailure === true && lastKnown) {
        return { ...lastKnown, stale: true };
      }
      throw new CurrencyRateError('CURRENCY_PROVIDER_UNAVAILABLE');
    }
  }
}
