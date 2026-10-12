import { createHash } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { writeSecurityIncident } from './security-incident';
import { restrictSourceTemporarily } from './temporary-source-restriction';

export const SCAN_ALERT_THRESHOLD = 40;
export const RESOURCE_PROBE_ALERT_THRESHOLD = 60;
export const SCAN_WINDOW_SECONDS = 5 * 60;
export const RESOURCE_KEY_MAX_LENGTH = 180;
export const RESOURCE_PROBE_WINDOW_SECONDS = 5 * 60;
const ALERT_DEDUP_SECONDS = 60 * 60;

type CommonInput = {
  redis: Redis;
  prisma: FastifyInstance['prisma'];
  logger: FastifyBaseLogger;
  statusCode: number;
};

export async function monitorUnmatchedRouteScan(input: CommonInput & {
  routeMatched: boolean;
  sourceIp?: string;
  requestPath?: string;
}): Promise<void> {
  if (input.statusCode !== 404 || input.routeMatched || !input.sourceIp) return;
  const ipFingerprint = createHash('sha256').update(input.sourceIp).digest('hex');
  const normalizedPath = (input.requestPath ?? '').split('?', 1)[0].slice(0, RESOURCE_KEY_MAX_LENGTH);
  if (!normalizedPath) return;
  const pathFingerprint = createHash('sha256').update(normalizedPath).digest('hex');
  const key = `averon:v1:security:unknown-routes:${ipFingerprint}`;
  try {
    const count = Number(await input.redis.eval(
      "local added = redis.call('SADD', KEYS[1], ARGV[1]); if added == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]); end; return redis.call('SCARD', KEYS[1])",
      1,
      key,
      pathFingerprint,
      String(SCAN_WINDOW_SECONDS),
    ));
    if (count < SCAN_ALERT_THRESHOLD) return;
    await restrictSourceTemporarily(input.redis, input.sourceIp, '/unmatched', input.logger);
    const alertKey = `${key}:alert`;
    const claimed = await input.redis.set(alertKey, '1', 'EX', ALERT_DEDUP_SECONDS, 'NX');
    if (claimed !== 'OK') return;
    await writeSecurityIncident(input.prisma, input.logger, {
      category: 'UNKNOWN_ROUTE_SCAN',
      threshold: SCAN_ALERT_THRESHOLD,
      windowSeconds: SCAN_WINDOW_SECONDS,
    });
  } catch {
    input.logger.warn({ event: 'security_monitor_unavailable', category: 'UNKNOWN_ROUTE_SCAN' }, 'Security monitoring failed open');
  }
}

export async function monitorResourceNotFoundProbes(input: CommonInput & {
  routeMatched: boolean;
  routeTemplate?: string;
  resourceId?: string;
  sourceIp?: string;
}): Promise<void> {
  if (input.statusCode !== 404 || !input.routeMatched || !input.sourceIp || !input.routeTemplate || !input.resourceId) return;
  if (input.resourceId.length > RESOURCE_KEY_MAX_LENGTH) return;
  const route = input.routeTemplate;
  const allowedRoutes = new Set([
    '/api/v1/orders/me/:orderNumber',
    '/api/v1/admin/orders/:orderNumber',
    '/admin/users/:id/ai-sessions',
  ]);
  if (!allowedRoutes.has(route)) return;
  const routeFingerprint = createHash('sha256').update(route).digest('hex');
  const ipFingerprint = createHash('sha256').update(input.sourceIp).digest('hex');
  const resourceFingerprint = createHash('sha256').update(input.resourceId).digest('hex');
  const key = `averon:v1:security:resource-probes:${ipFingerprint}:${routeFingerprint}`;
  try {
    const count = Number(await input.redis.eval(
      "local added = redis.call('SADD', KEYS[1], ARGV[1]); if added == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]); end; return redis.call('SCARD', KEYS[1])",
      1,
      key,
      resourceFingerprint,
      String(RESOURCE_PROBE_WINDOW_SECONDS),
    ));
    if (count < RESOURCE_PROBE_ALERT_THRESHOLD) return;
    await restrictSourceTemporarily(input.redis, input.sourceIp, route, input.logger);
    const alertKey = `${key}:alert`;
    const claimed = await input.redis.set(alertKey, '1', 'EX', ALERT_DEDUP_SECONDS, 'NX');
    if (claimed !== 'OK') return;
    await writeSecurityIncident(input.prisma, input.logger, {
      category: 'RESOURCE_ID_PROBE',
      routeTemplate: route,
      threshold: RESOURCE_PROBE_ALERT_THRESHOLD,
      windowSeconds: RESOURCE_PROBE_WINDOW_SECONDS,
    });
  } catch {
    input.logger.warn({ event: 'security_monitor_unavailable', category: 'RESOURCE_ID_PROBE' }, 'Security monitoring failed open');
  }
}
