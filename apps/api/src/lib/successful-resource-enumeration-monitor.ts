import { createHash } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { writeSecurityIncident } from './security-incident';

export const ENUMERATION_ALERT_THRESHOLD = 60;
export const ENUMERATION_WINDOW_SECONDS = 5 * 60;
export const MAX_RESOURCE_KEY_LENGTH = 180;
const ALERT_DEDUP_SECONDS = 60 * 60;

type Input = {
  redis: Redis;
  prisma: FastifyInstance['prisma'];
  logger: FastifyBaseLogger;
  method: string;
  statusCode: number;
  userId?: string;
  routeTemplate?: string;
  resourceId?: string;
};

export async function monitorSuccessfulResourceEnumeration(input: Input): Promise<void> {
  if (input.method !== 'GET' || input.statusCode !== 200 || !input.userId) return;
  const route = input.routeTemplate;
  const allowedRoutes = new Set([
    '/api/v1/orders/me/:orderNumber',
    '/api/v1/admin/orders/:orderNumber',
    '/admin/users/:id/ai-sessions',
  ]);
  if (!route || !allowedRoutes.has(route) || !input.resourceId) return;
  if (input.resourceId.length > MAX_RESOURCE_KEY_LENGTH) return;

  const accountFingerprint = createHash('sha256').update(input.userId).digest('hex');
  const routeFingerprint = createHash('sha256').update(route).digest('hex');
  const resourceFingerprint = createHash('sha256').update(input.resourceId).digest('hex');
  const key = `averon:v1:security:resource-reads:${accountFingerprint}:${routeFingerprint}`;
  try {
    const count = Number(await input.redis.eval(
      "local added = redis.call('SADD', KEYS[1], ARGV[1]); if added == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]); end; return redis.call('SCARD', KEYS[1])",
      1,
      key,
      resourceFingerprint,
      String(ENUMERATION_WINDOW_SECONDS),
    ));
    if (count < ENUMERATION_ALERT_THRESHOLD) return;
    const alertKey = `${key}:alert`;
    const claimed = await input.redis.set(alertKey, '1', 'EX', ALERT_DEDUP_SECONDS, 'NX');
    if (claimed !== 'OK') return;
    await writeSecurityIncident(input.prisma, input.logger, {
      category: 'PRIVATE_RESOURCE_ENUMERATION',
      routeTemplate: route,
      threshold: ENUMERATION_ALERT_THRESHOLD,
      windowSeconds: ENUMERATION_WINDOW_SECONDS,
    });
  } catch {
    input.logger.warn({ event: 'security_monitor_unavailable', category: 'PRIVATE_RESOURCE_ENUMERATION' }, 'Security monitoring failed open');
  }
}
