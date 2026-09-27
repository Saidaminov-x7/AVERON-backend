// apps/api/src/lib/jobs/expire-promotions.ts

import { PrismaClient } from '@prisma/client';
import { FastifyBaseLogger } from 'fastify';

/**
 * Очистка истёкших промо-периодов (Boost/VIP)
 */
export async function expirePromotions(prisma: PrismaClient, logger?: FastifyBaseLogger) {
  try {
    const result = await prisma.listing.updateMany({
      where: {
        isPromoted: true,
        promotedUntil: { lt: new Date() },
      },
      data: {
        isPromoted: false,
        promotionTier: null,
      },
    });

    if (result.count > 0 && logger) {
      logger.info({ expiredCount: result.count }, '[Promotions] Expired promotions cleaned up');
    }
    return result.count;
  } catch (err) {
    if (logger) {
      logger.error({ err }, '[Promotions] Failed to expire promotions');
    }
    return 0;
  }
}
