import { describe, expect, it } from 'vitest';
import { recommendProductSize } from './size-recommendation';

const chart = [
  { size: 'M', recommendedHeightMinCm: 165, recommendedHeightMaxCm: 175, recommendedWeightMinKg: 55, recommendedWeightMaxKg: 68 },
  { size: 'L', recommendedHeightMinCm: 172, recommendedHeightMaxCm: 182, recommendedWeightMinKg: 65, recommendedWeightMaxKg: 78 },
  { size: 'XL', recommendedHeightMinCm: 178, recommendedHeightMaxCm: 188, recommendedWeightMinKg: 75, recommendedWeightMaxKg: 90 },
];

describe('recommendProductSize', () => {
  it('returns a product-specific size for matching height and weight', () => {
    expect(recommendProductSize(chart, { heightCm: 169, weightKg: 60 })?.size).toBe('M');
  });
  it('returns null without a product chart, profile, or complete matching data', () => {
    expect(recommendProductSize(null, { heightCm: 170, weightKg: 60 })).toBeNull();
    expect(recommendProductSize(chart, null)).toBeNull();
    expect(recommendProductSize([{ size: 'M', recommendedHeightMinCm: 165 }], { heightCm: 170, weightKg: 60 })).toBeNull();
    expect(recommendProductSize(chart, { heightCm: 200, weightKg: 100 })).toBeNull();
  });
  it('selects the closest row in overlapping ranges and lowers confidence at ties', () => {
    const result = recommendProductSize(chart, { heightCm: 174, weightKg: 67 });
    expect(['M', 'L']).toContain(result?.size);
    expect(result?.confidence).toBe('low');
  });
});
