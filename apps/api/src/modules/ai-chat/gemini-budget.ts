import { createHash } from 'node:crypto';

/**
 * Application-side reservation cap for the dedicated Gemini 2.5 Flash text path.
 * This is not a provider invoice cap: other key users and provider pricing changes
 * are outside this Redis ledger.
 */
export const GEMINI_BUDGET_MODEL = 'gemini-2.5-flash';
export const GEMINI_MONTHLY_BUDGET_USD = 10;

// 0.1 micro-USD units avoid floating point arithmetic: input=3 and output=25
// units per token at the documented Standard rates ($0.30/$2.50 per 1M tokens).
const UNITS_PER_USD = 10_000_000;
const INPUT_UNITS_PER_TOKEN = 3;
const OUTPUT_UNITS_PER_TOKEN = 25;
const MONTHLY_BUDGET_UNITS = GEMINI_MONTHLY_BUDGET_USD * UNITS_PER_USD;
const RETENTION_SECONDS = 100 * 24 * 60 * 60;

export interface GeminiBudgetRedis {
  eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>;
  info(section: 'persistence'): Promise<string>;
  config(action: 'GET', ...parameters: string[]): Promise<unknown>;
}

export interface GeminiBudgetRequest {
  userId: string;
  requestId: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
}

export interface GeminiBudgetReservation {
  reservationId: string;
}

export interface GeminiBudgetSettlement {
  reservationId: string;
  actualInputTokens: number;
  actualOutputTokens: number;
}

const reserveScript = [
  "local existing = redis.call('GET', KEYS[2]);",
  'local requested = tonumber(ARGV[1]);',
  'if existing then if tonumber(existing) >= requested then return 2 else return 0 end end;',
  "local current = tonumber(redis.call('GET', KEYS[1]) or '0');",
  'if current + requested > tonumber(ARGV[2]) then return 0 end;',
  "redis.call('SET', KEYS[2], requested, 'EX', ARGV[3], 'NX');",
  "redis.call('INCRBY', KEYS[1], requested);",
  'redis.call("EXPIRE", KEYS[1], ARGV[3]);',
  'return 1',
].join(' ');

const settleScript = [
  "local reserved = tonumber(redis.call('GET', KEYS[2]));",
  'if not reserved then return 0 end;',
  'local actual = tonumber(ARGV[1]);',
  // Never increase a reservation during settlement. An over-bound or malformed
  // usage report leaves the conservative reservation untouched.
  'if not actual or actual < 0 or actual > reserved then return 0 end;',
  'local release = reserved - actual;',
  'if release > 0 then redis.call("DECRBY", KEYS[1], release); end;',
  "redis.call('SET', KEYS[2], actual, 'EX', ARGV[2]);",
  'return 1',
].join(' ');

function currentUtcMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function isSafeTokenBound(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function costUnits(inputTokens: number, outputTokens: number): number {
  return inputTokens * INPUT_UNITS_PER_TOKEN + outputTokens * OUTPUT_UNITS_PER_TOKEN;
}

function keyPart(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createGeminiBudget(
  redis: GeminiBudgetRedis,
  model: string = GEMINI_BUDGET_MODEL,
  now: () => Date = () => new Date(),
) {
  async function hasRequiredRedisRetention(): Promise<boolean> {
    // Fail closed when a managed Redis service hides these settings. This guards
    // common restart/eviction loss modes, but cannot make Redis or provider
    // billing an absolute durable invoice ledger.
    const [persistenceInfo, configValues] = await Promise.all([
      redis.info('persistence'),
      redis.config('GET', 'appendonly', 'appendfsync', 'maxmemory-policy'),
    ]);
    if (!Array.isArray(configValues) || !configValues.every((value) => typeof value === 'string')) return false;
    const settings = new Map<string, string>();
    for (let index = 0; index + 1 < configValues.length; index += 2) {
      settings.set(configValues[index], configValues[index + 1]);
    }
    return /(?:^|\n)aof_enabled:1(?:\r?\n|$)/.test(persistenceInfo)
      && /(?:^|\n)aof_last_write_status:ok(?:\r?\n|$)/.test(persistenceInfo)
      && settings.get('appendonly') === 'yes'
      && settings.get('appendfsync') === 'always'
      && settings.get('maxmemory-policy') === 'noeviction';
  }

  async function reserveGeminiBudget(input: GeminiBudgetRequest): Promise<GeminiBudgetReservation | null> {
    if (
      model !== GEMINI_BUDGET_MODEL ||
      !input.userId.trim() ||
      !input.requestId.trim() ||
      !isSafeTokenBound(input.estimatedInputTokens) ||
      !isSafeTokenBound(input.maxOutputTokens)
    ) return null;

    const month = currentUtcMonth(now());
    const aggregateKey = `ai:gemini:budget:${month}:reserved-units`;
    const reservationId = `ai:gemini:budget:${month}:reservation:${keyPart(JSON.stringify([input.userId, input.requestId]))}`;
    const requestedUnits = costUnits(input.estimatedInputTokens, input.maxOutputTokens);
    if (!Number.isSafeInteger(requestedUnits) || requestedUnits > MONTHLY_BUDGET_UNITS) return null;

    try {
      if (!await hasRequiredRedisRetention()) return null;
      const result = Number(await redis.eval(
        reserveScript,
        2,
        aggregateKey,
        reservationId,
        String(requestedUnits),
        String(MONTHLY_BUDGET_UNITS),
        String(RETENTION_SECONDS),
      ));
      return result === 1 || result === 2 ? { reservationId } : null;
    } catch {
      // Fail closed. A Redis timeout may have committed, so do not attempt an
      // unsafe local fallback or release; retrying the same requestId is safe.
      return null;
    }
  }

  async function settleGeminiBudget(input: GeminiBudgetSettlement): Promise<void> {
    if (
      model !== GEMINI_BUDGET_MODEL ||
      !input.reservationId.startsWith('ai:gemini:budget:') ||
      !isSafeTokenBound(input.actualInputTokens) ||
      !isSafeTokenBound(input.actualOutputTokens)
    ) return;

    const match = /^ai:gemini:budget:(\d{4}-\d{2}):reservation:[a-f0-9]{64}$/.exec(input.reservationId);
    if (!match) return;
    const month = match[1];
    const aggregateKey = `ai:gemini:budget:${month}:reserved-units`;
    const actualUnits = costUnits(input.actualInputTokens, input.actualOutputTokens);
    if (!Number.isSafeInteger(actualUnits)) return;

    // A settlement failure leaves the original reservation in Redis. Callers
    // may log a sanitized operational error, but must never delete the reserve.
    await redis.eval(
      settleScript,
      2,
      aggregateKey,
      input.reservationId,
      String(actualUnits),
      String(RETENTION_SECONDS),
    );
  }

  return { reserveGeminiBudget, settleGeminiBudget };
}
