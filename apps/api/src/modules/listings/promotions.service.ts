// apps/api/src/modules/listings/promotions.service.ts

import { PrismaClient } from '@prisma/client';

export class PromotionsService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Проверка доступности промокода для конкретного пользователя
   */
  async validatePromoCode(code: string, userId: string) {
    const promo = await this.prisma.promoCode.findUnique({
      where: { code: code.toUpperCase().trim() },
    });

    if (!promo) {
      return { valid: false, error: 'Промокод не найден' };
    }

    if (!promo.isActive) {
      return { valid: false, error: 'Промокод неактивен' };
    }

    if (promo.expiresAt && promo.expiresAt < new Date()) {
      return { valid: false, error: 'Срок действия промокода истек' };
    }

    if (promo.usedCount >= promo.maxUses) {
      return { valid: false, error: 'Лимит использования промокода исчерпан' };
    }

    // Проверяем, использовал ли уже этот конкретный пользователь данный промокод
    const existingUsage = await this.prisma.promoCodeUsage.findUnique({
      where: {
        promoCodeId_userId: {
          promoCodeId: promo.id,
          userId,
        },
      },
    });

    if (existingUsage) {
      return { valid: false, error: 'Вы уже использовали этот промокод' };
    }

    return {
      valid: true,
      promoCodeId: promo.id,
      code: promo.code,
      discountPercent: promo.discountPercent,
    };
  }

  /**
   * Применение промокода пользователем
   */
  async applyPromoCode(code: string, userId: string) {
    const validation = await this.validatePromoCode(code, userId);
    if (!validation.valid || !validation.promoCodeId) {
      throw new Error(validation.error || 'Недействительный промокод');
    }

    // Создаем запись использования и увеличиваем счетчик атомарно в транзакции
    return this.prisma.$transaction(async (tx) => {
      const usage = await tx.promoCodeUsage.create({
        data: {
          promoCodeId: validation.promoCodeId!,
          userId,
        },
      });

      await tx.promoCode.update({
        where: { id: validation.promoCodeId! },
        data: {
          usedCount: { increment: 1 },
        },
      });

      return {
        usage,
        discountPercent: validation.discountPercent,
      };
    });
  }

  /**
   * Снимает VIP-статус и продвижение у объявлений с истёкшим сроком действия
   */
  async expirePromotions(now: Date = new Date()) {
    return this.prisma.listing.updateMany({
      where: {
        isPromoted: true,
        promotedUntil: { lte: now },
      },
      data: {
        isPromoted: false,
        promotedUntil: null,
        promotionTier: null,
      },
    });
  }
}

