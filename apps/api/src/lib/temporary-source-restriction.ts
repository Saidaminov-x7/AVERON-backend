import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';

export const TEMPORARY_SOURCE_RESTRICTION_SECONDS = 10 * 60;

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function temporarySourceRestrictionKey(sourceIp: string, routeScope: string): string {
  return `averon:v1:security:source-restriction:${fingerprint(sourceIp)}:${fingerprint(routeScope)}`;
}

export async function restrictSourceTemporarily(
  redis: Redis,
  sourceIp: string,
  routeScope: string,
  logger?: FastifyBaseLogger,
): Promise<void> {
  try {
    await redis.set(
      temporarySourceRestrictionKey(sourceIp, routeScope),
      '1',
      'EX',
      TEMPORARY_SOURCE_RESTRICTION_SECONDS,
      'NX',
    );
  } catch {
    logger?.warn({ event: 'security_monitor_unavailable', category: 'TEMPORARY_SOURCE_RESTRICTION' }, 'Security monitoring failed open');
  }
}

export async function isSourceTemporarilyRestricted(
  redis: Redis,
  sourceIp: string,
  routeScope: string,
  logger?: FastifyBaseLogger,
): Promise<boolean> {
  try {
    return await redis.get(temporarySourceRestrictionKey(sourceIp, routeScope)) === '1';
  } catch {
    logger?.warn({ event: 'security_monitor_unavailable', category: 'TEMPORARY_SOURCE_RESTRICTION' }, 'Security monitoring failed open');
    return false;
  }
}
