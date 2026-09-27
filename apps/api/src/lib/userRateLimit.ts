// apps/api/src/lib/userRateLimit.ts

import { FastifyRequest, FastifyReply } from 'fastify';
import { Redis } from 'ioredis';

export function createUserRateLimit(
  getRedis: (req: FastifyRequest) => Redis,
  opts: { keyPrefix: string; max: number; windowSec: number },
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const identifier = (request as any).user?.userId || request.ip || 'anonymous';
    const redis = getRedis(request);
    if (!redis) return;

    const key = `ratelimit:${opts.keyPrefix}:${identifier}`;
    try {
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, opts.windowSec);
      }
      if (count > opts.max) {
        return reply.status(429).send({
          statusCode: 429,
          error: 'Too Many Requests',
          message: `Слишком много запросов. Попробуйте через ${opts.windowSec} секунд.`,
        });
      }
    } catch {
      // При ошибке redis не блокируем пользователя
    }
  };
}

