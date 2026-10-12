import { createHash } from 'node:crypto';
import { restrictSourceTemporarily } from './temporary-source-restriction';

const SCAN_WINDOW_SECONDS = 5 * 60;
const SCAN_ALERT_THRESHOLD = 40;
const SCAN_RESTRICTION_THRESHOLD = 100;
const SCAN_RESTRICTION_DISTINCT_PATHS = 40;
const RESOURCE_PROBE_WINDOW_SECONDS = 5 * 60;
const RESOURCE_PROBE_ALERT_THRESHOLD = 60;
const RESOURCE_RESTRICTION_THRESHOLD = 80;
const RESOURCE_RESTRICTION_DISTINCT_IDS = 50;
const ALERT_DEDUP_SECONDS = 60 * 60;

const incrementWindowScript = [
  'local count = redis.call(\'INCR\', KEYS[1]);',
  'if count == 1 then redis.call(\'EXPIRE\', KEYS[1], ARGV[1]); end;',
  'return count',
].join(' ');

type UnmatchedRouteMonitorDependencies = {
  redis: {
    get(key: string): Promise<string | null>;
    eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>;
    set(key: string, value: string, expiryMode: 'EX', seconds: number, condition: 'NX'): Promise<'OK' | null>;
    del(key: string): Promise<number>;
    sadd(key: string, member: string): Promise<number>;
    scard(key: string): Promise<number>;
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

/** Alert on repeated unknown-route probes; a single 404 never blocks a user. */
export async function monitorUnmatchedRouteScan(
  dependencies: UnmatchedRouteMonitorDependencies,
  input: {
    sourceIp?: string | null;
    routeMatched: boolean;
    routeFingerprint?: string;
    method?: string;
    authenticated?: boolean;
    trustedClientIp?: boolean;
    statusCode: number;
  },
): Promise<void> {
  if (input.statusCode !== 404 || input.routeMatched || !input.sourceIp || input.method === 'OPTIONS') return;

  const sourceHash = createHash('sha256').update(input.sourceIp).digest('hex');
  const counterKey = `averon:v1:security:unmatched-routes:${sourceHash}`;
  const alertKey = `averon:v1:security:unmatched-routes-alert:${sourceHash}`;

  try {
    const count = Number(await dependencies.redis.eval(
      incrementWindowScript,
      1,
      counterKey,
      String(SCAN_WINDOW_SECONDS),
    ));
    let distinctPathCount = 0;
    if (input.routeFingerprint && count >= SCAN_ALERT_THRESHOLD) {
      const fingerprintsKey = `averon:v1:security:unmatched-route-fingerprints:${sourceHash}`;
      await dependencies.redis.sadd(fingerprintsKey, input.routeFingerprint.slice(0, 64));
      await dependencies.redis.expire(fingerprintsKey, SCAN_WINDOW_SECONDS);
      distinctPathCount = await dependencies.redis.scard(fingerprintsKey);
    }

    if (
      !input.authenticated
      && input.trustedClientIp === true
      && count >= SCAN_RESTRICTION_THRESHOLD
      && count % 10 === 0
      && distinctPathCount >= SCAN_RESTRICTION_DISTINCT_PATHS
    ) {
      await restrictSourceTemporarily(dependencies.redis, input.sourceIp, 'unmatched-route-scan');
    }

    if (!Number.isFinite(count) || count < SCAN_ALERT_THRESHOLD) return;

    const claimed = await dependencies.redis.set(alertKey, '1', 'EX', ALERT_DEDUP_SECONDS, 'NX');
    if (claimed !== 'OK') return;

    const sourceLabel = sourceHash.slice(0, 12);
    dependencies.warn({
      sourceHash: sourceLabel,
      statusCode: input.statusCode,
      unmatchedRequests: count,
      windowSeconds: SCAN_WINDOW_SECONDS,
    }, 'Repeated unmatched-route probes detected');

    try {
      await dependencies.createAdminNotification({
        type: 'SECURITY_INCIDENT',
        title: 'Repeated unmatched-route probes',
        message: `Network source ${sourceLabel} received ${count} unmatched-route 404 responses within five minutes. Review the security audit log.`,
        link: '/audit-log',
      });
    } catch (error) {
      await dependencies.redis.del(alertKey).catch(() => undefined);
      dependencies.error({
        sourceHash: sourceLabel,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }, 'Failed to publish unmatched-route alert');
    }
  } catch (error) {
    dependencies.warn({
      errorType: error instanceof Error ? error.name : 'UnknownError',
    }, 'Unmatched-route monitoring unavailable');
  }
}

/** Alert on repeated missing IDs along a registered parameterized route. */
export async function monitorResourceNotFoundProbes(
  dependencies: UnmatchedRouteMonitorDependencies,
  input: {
    sourceIp?: string | null;
    routeTemplate?: string;
    resourceFingerprint?: string;
    method?: string;
    authenticated?: boolean;
    trustedClientIp?: boolean;
    statusCode: number;
  },
): Promise<void> {
  const routeTemplate = input.routeTemplate?.trim();
  const isParameterizedRoute = routeTemplate?.split('/').some((segment) => segment.startsWith(':')) ?? false;
  if (
    input.statusCode !== 404
    || !input.sourceIp
    || !routeTemplate
    || !isParameterizedRoute
    || (input.method && input.method !== 'GET')
  ) return;

  const sourceHash = createHash('sha256').update(input.sourceIp).digest('hex');
  const routeHash = createHash('sha256').update(routeTemplate).digest('hex');
  const counterKey = `averon:v1:security:resource-not-found:${sourceHash}:${routeHash}`;
  const alertKey = `averon:v1:security:resource-not-found-alert:${sourceHash}:${routeHash}`;

  try {
    const count = Number(await dependencies.redis.eval(
      incrementWindowScript,
      1,
      counterKey,
      String(RESOURCE_PROBE_WINDOW_SECONDS),
    ));
    let distinctIdCount = 0;
    if (input.resourceFingerprint && count >= RESOURCE_PROBE_ALERT_THRESHOLD) {
      const fingerprintsKey = `averon:v1:security:resource-not-found-fingerprints:${sourceHash}:${routeHash}`;
      await dependencies.redis.sadd(fingerprintsKey, input.resourceFingerprint.slice(0, 64));
      await dependencies.redis.expire(fingerprintsKey, RESOURCE_PROBE_WINDOW_SECONDS);
      distinctIdCount = await dependencies.redis.scard(fingerprintsKey);
    }

    if (
      !input.authenticated
      && input.trustedClientIp === true
      && count >= RESOURCE_RESTRICTION_THRESHOLD
      && count % 10 === 0
      && distinctIdCount >= RESOURCE_RESTRICTION_DISTINCT_IDS
    ) {
      await restrictSourceTemporarily(dependencies.redis, input.sourceIp, 'resource-id-probe');
    }

    if (!Number.isFinite(count) || count < RESOURCE_PROBE_ALERT_THRESHOLD) return;

    const claimed = await dependencies.redis.set(alertKey, '1', 'EX', ALERT_DEDUP_SECONDS, 'NX');
    if (claimed !== 'OK') return;

    const sourceLabel = sourceHash.slice(0, 12);
    dependencies.warn({
      sourceHash: sourceLabel,
      route: routeTemplate,
      statusCode: input.statusCode,
      missingResourceRequests: count,
      windowSeconds: RESOURCE_PROBE_WINDOW_SECONDS,
    }, 'Repeated parameterized-route 404 probes detected');

    try {
      await dependencies.createAdminNotification({
        type: 'SECURITY_INCIDENT',
        title: 'Repeated resource-not-found probes',
        message: `Network source ${sourceLabel} received ${count} resource-not-found responses on ${routeTemplate} within five minutes. Review the security audit log.`,
        link: '/audit-log',
      });
    } catch (error) {
      await dependencies.redis.del(alertKey).catch(() => undefined);
      dependencies.error({
        sourceHash: sourceLabel,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }, 'Failed to publish resource-probe alert');
    }
  } catch (error) {
    dependencies.warn({
      errorType: error instanceof Error ? error.name : 'UnknownError',
    }, 'Resource-probe monitoring unavailable');
  }
}
