export type ProductSizeChartRow = {
  size: string;
  recommendedHeightMinCm?: number;
  recommendedHeightMaxCm?: number;
  recommendedWeightMinKg?: number;
  recommendedWeightMaxKg?: number;
};

export type SizeRecommendation = {
  size: string;
  confidence: 'medium' | 'low';
  fit: 'regular';
} | null;

export function recommendProductSize(
  chart: unknown,
  profile: { heightCm?: number | null; weightKg?: number | null } | null | undefined,
): SizeRecommendation {
  if (!Array.isArray(chart) || !profile?.heightCm || !profile.weightKg) return null;
  const matches = (chart as ProductSizeChartRow[]).filter((row) => {
    if (!row || typeof row.size !== 'string' || !row.size.trim()) return false;
    const hasHeight = row.recommendedHeightMinCm !== undefined || row.recommendedHeightMaxCm !== undefined;
    const hasWeight = row.recommendedWeightMinKg !== undefined || row.recommendedWeightMaxKg !== undefined;
    if (!hasHeight || !hasWeight) return false;
    return profile.heightCm! >= (row.recommendedHeightMinCm ?? 0)
      && profile.heightCm! <= (row.recommendedHeightMaxCm ?? Number.POSITIVE_INFINITY)
      && profile.weightKg! >= (row.recommendedWeightMinKg ?? 0)
      && profile.weightKg! <= (row.recommendedWeightMaxKg ?? Number.POSITIVE_INFINITY);
  });
  if (!matches.length) return null;

  const scored = matches.map((row) => {
    const heightMid = ((row.recommendedHeightMinCm ?? profile.heightCm!) + (row.recommendedHeightMaxCm ?? profile.heightCm!)) / 2;
    const weightMid = ((row.recommendedWeightMinKg ?? profile.weightKg!) + (row.recommendedWeightMaxKg ?? profile.weightKg!)) / 2;
    const heightRange = Math.max(1, (row.recommendedHeightMaxCm ?? profile.heightCm!) - (row.recommendedHeightMinCm ?? profile.heightCm!));
    const weightRange = Math.max(1, (row.recommendedWeightMaxKg ?? profile.weightKg!) - (row.recommendedWeightMinKg ?? profile.weightKg!));
    const distance = Math.abs(profile.heightCm! - heightMid) / heightRange + Math.abs(profile.weightKg! - weightMid) / weightRange;
    return { row, distance };
  }).sort((a, b) => a.distance - b.distance);
  const best = scored[0];
  const ambiguous = matches.length > 1 || (scored.length > 1 && Math.abs(scored[1].distance - best.distance) < 0.15);
  const boundary = best.distance > 0.75;
  return { size: best.row.size, confidence: ambiguous || boundary ? 'low' : 'medium', fit: 'regular' };
}
