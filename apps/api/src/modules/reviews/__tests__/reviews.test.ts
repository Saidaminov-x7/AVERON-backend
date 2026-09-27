// apps/api/src/modules/reviews/__tests__/reviews.test.ts

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

const createReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().min(3).max(1000),
});

describe('Reviews Module Validation & Moderation', () => {
  it('валидирует корректный отзыв с оценкой от 1 до 5', () => {
    const valid = createReviewSchema.safeParse({
      rating: 5,
      comment: 'Отличная квартира, чистая и уютная. Хозяин пунктуальный.',
    });
    expect(valid.success).toBe(true);
  });

  it('отклоняет оценку вне диапазона 1-5', () => {
    const invalidLow = createReviewSchema.safeParse({
      rating: 0,
      comment: 'Плохо',
    });
    expect(invalidLow.success).toBe(false);

    const invalidHigh = createReviewSchema.safeParse({
      rating: 6,
      comment: 'Слишком хорошо',
    });
    expect(invalidHigh.success).toBe(false);
  });

  it('отклоняет слишком короткий отзыв (< 3 символов)', () => {
    const tooShort = createReviewSchema.safeParse({
      rating: 4,
      comment: 'ок',
    });
    expect(tooShort.success).toBe(false);
  });
});
