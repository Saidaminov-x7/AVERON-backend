import { createHash } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { writeSecurityIncident } from './security-incident';

export const DENIAL_ALERT_THRESHOLD = 12;
export const DENIAL_WINDOW_SECONDS = 5 * 60;
export const ALERT_DEDUP_SECONDS = 60 * 60;

type Input = {
  redis: Redis;
  prisma: FastifyInstance['prisma'];
  logger: FastifyBaseLogger;
  statusCode: number;
  userId?: string;
  routeTemplate?: string;
};

export async function monitorAuthenticatedAuthorizationDenial(input: Input): Promise<void> {
  if (input.statusCode !== 403 || !input.userId) return;
  const route = input.routeTemplate && /^\/[A-Za-z0-9_:/-]{1,180}$/.test(input.routeTemplate)
    ? input.routeTemplate
    : '/unmatched';
  const accountFingerprint = createHash('sha256').update(input.userId).digest('hex');
  const routeFingerprint = createHash('sha256').update(route).digest('hex');
  const key = `averon:v1:security:denials:${accountFingerprint}:${routeFingerprint}`;
  try {
    const count = Number(await input.redis.eval(
      "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return count",
      1,
      key,
      String(DENIAL_WINDOW_SECONDS),
    ));
    if (count < DENIAL_ALERT_THRESHOLD) return;
    const alertKey = `${key}:alert`;
    const claimed = await input.redis.set(alertKey, '1', 'EX', ALERT_DEDUP_SECONDS, 'NX');
    if (claimed !== 'OK') return;
    await writeSecurityIncident(input.prisma, input.logger, {
      category: 'AUTHORIZATION_DENIALS',
      routeTemplate: route,
      threshold: DENIAL_ALERT_THRESHOLD,
      windowSeconds: DENIAL_WINDOW_SECONDS,
    });
  } catch {
    input.logger.warn({ event: 'security_monitor_unavailable', category: 'AUTHORIZATION_DENIALS' }, 'Security monitoring failed open');
  }
}
