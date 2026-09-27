// apps/api/src/modules/listings/__tests__/promotions.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PromotionsService } from '../promotions.service';

describe('PromotionsService.expirePromotions', () => {
  let prismaMock: any;
  let service: PromotionsService;

  beforeEach(() => {
    prismaMock = {
      listing: {
        updateMany: vi.fn().mockResolvedValue({ count: 3 }),
      },
    };
    service = new PromotionsService(prismaMock);
  });

  it('снимает VIP-статус и продвижение у объявлений с истёкшим сроком', async () => {
    const now = new Date('2026-01-15T00:00:00Z');

    const result = await service.expirePromotions(now);

    expect(prismaMock.listing.updateMany).toHaveBeenCalledWith({
      where: { isPromoted: true, promotedUntil: { lte: now } },
      data: { isPromoted: false, promotedUntil: null, promotionTier: null },
    });
    expect(result.count).toBe(3);
  });
});
