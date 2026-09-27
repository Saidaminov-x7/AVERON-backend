// apps/api/src/lib/activityLogger.ts
import { PrismaClient } from '@prisma/client';
import { FastifyRequest } from 'fastify';

export async function logUserActivity(
  prisma: PrismaClient,
  userId: string,
  action: string,
  request: FastifyRequest,
  meta?: Record<string, unknown>,
) {
  try {
    await prisma.userActivityLog.create({
      data: {
        userId,
        action,
        meta: meta ? (meta as any) : undefined,
        ip: request.ip,
        userAgent:
          typeof request.headers['user-agent'] === 'string'
            ? request.headers['user-agent'].slice(0, 500)
            : undefined,
      },
    });
  } catch (err) {
    request.log?.warn?.({ err }, 'Failed to log user activity');
  }
}
