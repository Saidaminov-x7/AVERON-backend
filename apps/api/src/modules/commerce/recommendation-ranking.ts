import { Prisma } from '@prisma/client';

export const RECOMMENDATION_LIMIT = 12;
export const RECOMMENDATION_CANDIDATE_LIMIT = 120;
export const RECENT_HISTORY_LIMIT = 24;
export const RECENT_HISTORY_RETENTION_DAYS = 90;

export const RECOMMENDATION_WEIGHTS = {
  sameCategory: 3,
  siblingCategory: 4,
  metadataOverlap: 2,
  explicitFavorite: 2,
  viewedCategoryAffinity: 1.5,
  confidenceCappedReview: 1,
  freshness: 0.5,
} as const;

export type RecommendationAvailability = {
  available: boolean;
  preorder: boolean;
};

export type EligibleRecommendationProduct = {
  status: string;
  category: { active: boolean } | null;
  stock: number;
  preorderEnabled: boolean;
  preorderLimit: number;
  preorderReserved: number;
  variants: Array<{ active: boolean; stock: number }>;
};

export function recommendationAvailability(
  product: EligibleRecommendationProduct,
): RecommendationAvailability {
  const inStock = product.variants.some((variant) => variant.active && variant.stock > 0);
  const preorder = !inStock &&
    product.preorderEnabled &&
    Math.max(0, product.preorderLimit - product.preorderReserved) > 0;
  return { available: inStock || preorder, preorder };
}

export function isEligibleRecommendationProduct(product: EligibleRecommendationProduct): boolean {
  return product.status === 'PUBLISHED' &&
    (!product.category || product.category.active) &&
    recommendationAvailability(product).available;
}

export type RecommendationStrategy = 'RELATED' | 'YOU_MAY_ALSO_LIKE' | 'PERSONALIZED';
export type RecommendationReason =
  | 'RELATED_CATEGORY'
  | 'SIMILAR_STYLE'
  | 'POPULAR_IN_CATEGORY'
  | 'BASED_ON_RECENT_VIEWS'
  | 'BASED_ON_YOUR_INTERESTS';

export type RecommendationRow<T> = {
  productId: string;
  product: T;
  score: number;
  reasonCode: RecommendationReason;
};

export type RankingContext = {
  strategy: RecommendationStrategy;
  baseProductId?: string;
  baseCategoryId?: string | null;
  baseParentCategoryId?: string | null;
  baseMetadata?: string;
  viewedProductIds?: Set<string>;
  interestedCategoryIds?: Set<string>;
  favoriteProductIds?: Set<string>;
  now?: Date;
};

function metadata(product: {
  translations: Prisma.JsonValue;
  attributes: Prisma.JsonValue | null;
  material: string | null;
  category: { name: Prisma.JsonValue; slug: string } | null;
  variants: Array<{ color: string | null }>;
}): string {
  return JSON.stringify({
    translations: product.translations,
    attributes: product.attributes,
    material: product.material,
    category: product.category,
    colors: product.variants.map(({ color }) => color),
  }).toLocaleLowerCase();
}

export function rankRecommendations<T extends {
  status: string;
  stock: number;
  preorderEnabled: boolean;
  preorderLimit: number;
  preorderReserved: number;
  category: ({ id: string; parentId: string | null; active: boolean; name: Prisma.JsonValue; slug: string }) | null;
  variants: Array<{ color: string | null; active: boolean; stock: number }>;
  id: string;
  slug: string;
  categoryId: string | null;
  translations: Prisma.JsonValue;
  attributes: Prisma.JsonValue | null;
  material: string | null;
  createdAt: Date;
  publishedAt: Date | null;
  reviews: Array<{ rating: number }>;
}>(
  candidates: T[],
  context: RankingContext,
  limit = RECOMMENDATION_LIMIT,
): Array<RecommendationRow<T>> {
  const now = context.now ?? new Date();
  const seenIds = new Set<string>(context.baseProductId ? [context.baseProductId] : []);
  const candidateIds = new Set(seenIds);
  const candidateSlugs = new Set<string>();
  const categoryCounts = new Map<string, number>();
  const baseMetadata = context.baseMetadata ?? '';

  const ranked = candidates.flatMap((product) => {
    if (
      candidateIds.has(product.id) ||
      candidateSlugs.has(product.slug) ||
      !isEligibleRecommendationProduct(product)
    ) return [];
    candidateIds.add(product.id);
    candidateSlugs.add(product.slug);
    const details = metadata(product);
    const sameCategory = Boolean(context.baseCategoryId && product.categoryId === context.baseCategoryId);
    const siblingCategory = Boolean(
      context.baseParentCategoryId &&
      product.category?.parentId === context.baseParentCategoryId,
    );
    const metadataOverlap = baseMetadata
      ? baseMetadata.split(/[^a-z0-9а-яё]+/i).filter((term) => term.length > 3 && details.includes(term)).length
      : 0;
    const ratings = product.reviews.map(({ rating }) => rating).filter((rating) => rating >= 1 && rating <= 5);
    const reviewConfidence = Math.min(1, ratings.length / 5);
    const averageRating = ratings.length ? ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length : 0;
    const freshnessDays = Math.max(0, (now.getTime() - (product.publishedAt ?? product.createdAt).getTime()) / 86_400_000);
    const freshness = Math.max(0, 1 - freshnessDays / 180);
    let score = 0;
    let reasonCode: RecommendationReason = 'RELATED_CATEGORY';

    if (context.strategy === 'RELATED') {
      score += (sameCategory ? RECOMMENDATION_WEIGHTS.sameCategory : 0) +
        (siblingCategory ? RECOMMENDATION_WEIGHTS.siblingCategory : 0) +
        Math.min(2, metadataOverlap) * RECOMMENDATION_WEIGHTS.metadataOverlap;
      reasonCode = metadataOverlap > 0 ? 'SIMILAR_STYLE' : 'RELATED_CATEGORY';
    } else if (context.strategy === 'PERSONALIZED' && context.viewedProductIds?.size) {
      const viewed = context.viewedProductIds.has(product.id);
      const favorite = context.favoriteProductIds?.has(product.id) ?? false;
      const categoryAffinity = context.interestedCategoryIds?.has(product.categoryId ?? '') ?? false;
      if (viewed) return [];
      score += (favorite ? RECOMMENDATION_WEIGHTS.explicitFavorite : 0) +
        (categoryAffinity ? RECOMMENDATION_WEIGHTS.viewedCategoryAffinity : 0) +
        (sameCategory ? 1 : 0);
      reasonCode = favorite || categoryAffinity ? 'BASED_ON_YOUR_INTERESTS' : 'BASED_ON_RECENT_VIEWS';
    } else {
      score += averageRating / 5 * reviewConfidence * RECOMMENDATION_WEIGHTS.confidenceCappedReview;
      score += freshness * RECOMMENDATION_WEIGHTS.freshness;
      if (sameCategory) score += 0.25;
      reasonCode = 'RELATED_CATEGORY';
    }
    return [{ productId: product.id, product, score, reasonCode }];
  });

  ranked.sort((left, right) => right.score - left.score ||
    (right.product.publishedAt?.getTime() ?? right.product.createdAt.getTime()) -
    (left.product.publishedAt?.getTime() ?? left.product.createdAt.getTime()) ||
    left.product.id.localeCompare(right.product.id));

  const results: Array<RecommendationRow<T>> = [];
  for (const row of ranked) {
    const categoryId = row.product.categoryId ?? 'uncategorized';
    if ((categoryCounts.get(categoryId) ?? 0) >= 3) continue;
    results.push(row);
    seenIds.add(row.product.id);
    categoryCounts.set(categoryId, (categoryCounts.get(categoryId) ?? 0) + 1);
    if (results.length === limit) break;
  }
  return results;
}
