import { createHash } from 'node:crypto';

const ENUMERATION_WINDOW_SECONDS = 5 * 60;
const ALERT_DEDUP_SECONDS = 60 * 60;
const ALERT_RETRY_COOLDOWN_SECONDS = 60;
const MAX_RESOURCE_KEY_LENGTH = 256;

const addDistinctResourceScript = [
  'local count = redis.call(\'SCARD\', KEYS[1]);',
  'if count >= tonumber(ARGV[3]) then return count; end;',
  'local added = redis.call(\'SADD\', KEYS[1], ARGV[1]);',
  'if added == 1 and count == 0 then redis.call(\'EXPIRE\', KEYS[1], ARGV[2]); end;',
  'return redis.call(\'SCARD\', KEYS[1]);',
].join(' ');

const monitoredRoutes = new Map<string, { parameter: string; threshold: number }>([
  ['/api/v1/orders/me/:orderNumber', { parameter: 'orderNumber', threshold: 20 }],
  ['/api/v1/admin/orders/:orderNumber', { parameter: 'orderNumber', threshold: 50 }],
  ['/admin/users/:id', { parameter: 'id', threshold: 30 }],
  ['/admin/users/:id/sessions', { parameter: 'id', threshold: 30 }],
  ['/admin/users/:id/ai-sessions', { parameter: 'id', threshold: 30 }],
]);

type SuccessfulResourceEnumerationDependencies = {
  redis: {
    eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>;
    set(key: string, value: string, expiryMode: 'EX', seconds: number, condition: 'NX'): Promise<'OK' | null>;
    expire(key: string, seconds: number): Promise<number>;
  };
  createAdminNotification: (data: {
    type: string;
    title: string;
    message: string;
    link: string;
  }) => Promise<unknown>;
  warn: (fields: Record<string, unknown>, message: string) => void;
  error: (fields: Record<string, unknown>, message: string) => void;
};

/**
 * Raise a privacy-preserving alert when one authenticated account successfully
 * reads many distinct private resources through a known detail endpoint.
 * This monitor never blocks a request and stores only hashes of account/resource IDs.
 */
export async function monitorSuccessfulResourceEnumeration(
  dependencies: SuccessfulResourceEnumerationDependencies,
  input: {
    method: string;
    statusCode: number;
    userId?: string | null;
    routeTemplate?: string;
    params?: Record<string, unknown>;
  },
): Promise<void> {
  if (input.method !== 'GET' || input.statusCode !== 200 || !input.userId || !input.routeTemplate) return;

  const route = monitoredRoutes.get(input.routeTemplate);
  if (!route) return;

  const resourceId = input.params?.[route.parameter];
  if ((typeof resourceId !== 'string' && typeof resourceId !== 'number') || String(resourceId).length === 0) return;
  const resourceValue = String(resourceId);
  if (resourceValue.length > MAX_RESOURCE_KEY_LENGTH) return;

  const actorHash = createHash('sha256').update(input.userId).digest('hex');
  const resourceHash = createHash('sha256')
    .update(actorHash)
    .update('\0')
    .update(resourceValue)
    .digest('hex');
  const routeHash = createHash('sha256').update(input.routeTemplate).digest('hex');
  const counterKey = `averon:v1:security:successful-resource-reads:${actorHash}:${routeHash}`;
  const alertKey = `averon:v1:security:successful-resource-reads-alert:${actorHash}:${routeHash}`;

  try {
    const count = Number(await dependencies.redis.eval(
      addDistinctResourceScript,
      1,
      counterKey,
      resourceHash,
      String(ENUMERATION_WINDOW_SECONDS),
      String(route.threshold),
    ));
    if (!Number.isFinite(count) || count < route.threshold) return;

    const claimed = await dependencies.redis.set(alertKey, '1', 'EX', ALERT_DEDUP_SECONDS, 'NX');
    if (claimed !== 'OK') return;

    const actorLabel = actorHash.slice(0, 12);
    dependencies.warn({
      actorHash: actorLabel,
      route: input.routeTemplate,
      uniqueResourceReads: count,
      threshold: route.threshold,
      windowSeconds: ENUMERATION_WINDOW_SECONDS,
    }, 'High-volume successful private-resource reads detected');

    try {
      await dependencies.createAdminNotification({
        type: 'SECURITY_INCIDENT',
        title: 'High-volume private-resource access',
        message: `Authenticated account ${actorLabel} successfully read ${count} distinct resources on ${input.routeTemplate} within five minutes. Review the security audit log.`,
        link: '/audit-log',
      });
    } catch (error) {
      // Avoid retrying the failing notifier on every subsequent resource read.
      await dependencies.redis.expire(alertKey, ALERT_RETRY_COOLDOWN_SECONDS).catch(() => undefined);
      dependencies.error({
        actorHash: actorLabel,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }, 'Failed to publish successful-resource access alert');
    }
  } catch (error) {
    dependencies.warn({
      errorType: error instanceof Error ? error.name : 'UnknownError',
    }, 'Successful-resource monitoring unavailable');
  }
}
