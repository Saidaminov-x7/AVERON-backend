// apps/api/src/modules/listings/__tests__/promo-validation.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PromotionsService } from '../promotions.service';

describe('PromotionsService - Promo Codes & Per-User Usage Limit', () => {
  let prismaMock: any;
  let service: PromotionsService;

  beforeEach(() => {
    prismaMock = {
      promoCode: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      promoCodeUsage: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      $transaction: vi.fn((callback) => callback(prismaMock)),
      listing: {
        updateMany: vi.fn(),
      },
    };
    service = new PromotionsService(prismaMock);
  });

  it('успешно валидирует активный промокод при первом использовании', async () => {
    prismaMock.promoCode.findUnique.mockResolvedValue({
      id: 'promo-1',
      code: 'SUMMER2026',
      discountPercent: 20,
      maxUses: 100,
      usedCount: 5,
      isActive: true,
      expiresAt: new Date(Date.now() + 100000),
    });

    prismaMock.promoCodeUsage.findUnique.mockResolvedValue(null);

    const result = await service.validatePromoCode('SUMMER2026', 'user-123');

    expect(result.valid).toBe(true);
    expect(result.discountPercent).toBe(20);
    expect(result.promoCodeId).toBe('promo-1');
  });

  it('отклоняет промокод, если пользователь уже использовал его ранее', async () => {
    prismaMock.promoCode.findUnique.mockResolvedValue({
      id: 'promo-1',
      code: 'WELCOME10',
      discountPercent: 10,
      maxUses: 1000,
      usedCount: 20,
      isActive: true,
      expiresAt: null,
    });

    prismaMock.promoCodeUsage.findUnique.mockResolvedValue({
      id: 'usage-1',
      promoCodeId: 'promo-1',
      userId: 'user-123',
      usedAt: new Date(),
    });

    const result = await service.validatePromoCode('WELCOME10', 'user-123');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('уже использовали');
  });

  it('отклоняет просроченный промокод', async () => {
    prismaMock.promoCode.findUnique.mockResolvedValue({
      id: 'promo-expired',
      code: 'OLD2025',
      discountPercent: 15,
      maxUses: 50,
      usedCount: 10,
      isActive: true,
      expiresAt: new Date(Date.now() - 100000),
    });

    const result = await service.validatePromoCode('OLD2025', 'user-123');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('истек');
  });

  it('отклоняет промокод, исчерпавший общий лимит использований', async () => {
    prismaMock.promoCode.findUnique.mockResolvedValue({
      id: 'promo-exhausted',
      code: 'LIMIT50',
      discountPercent: 50,
      maxUses: 5,
      usedCount: 5,
      isActive: true,
      expiresAt: null,
    });

    const result = await service.validatePromoCode('LIMIT50', 'user-123');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('исчерпан');
  });

  it('атомарно фиксирует использование промокода и увеличивает счетчик', async () => {
    prismaMock.promoCode.findUnique.mockResolvedValue({
      id: 'promo-1',
      code: 'DISCOUNT',
      discountPercent: 15,
      maxUses: 10,
      usedCount: 0,
      isActive: true,
      expiresAt: null,
    });
    prismaMock.promoCodeUsage.findUnique.mockResolvedValue(null);
    prismaMock.promoCodeUsage.create.mockResolvedValue({ id: 'new-usage', promoCodeId: 'promo-1', userId: 'user-999' });
    prismaMock.promoCode.update.mockResolvedValue({});

    const result = await service.applyPromoCode('DISCOUNT', 'user-999');

    expect(result.discountPercent).toBe(15);
    expect(prismaMock.promoCodeUsage.create).toHaveBeenCalledWith({
      data: { promoCodeId: 'promo-1', userId: 'user-999' },
    });
    expect(prismaMock.promoCode.update).toHaveBeenCalledWith({
      where: { id: 'promo-1' },
      data: { usedCount: { increment: 1 } },
    });
  });
});
