import { describe, expect, it } from 'vitest';
import {
  isEligibleRecommendationProduct,
  rankRecommendations,
} from '../recommendation-ranking';

function product(id: string, options: {
  status?: string;
  categoryId?: string;
  active?: boolean;
  stock?: number;
  variantStock?: number;
  preorderEnabled?: boolean;
  preorderLimit?: number;
  preorderReserved?: number;
  rating?: number;
  createdAt?: Date;
} = {}) {
  return {
    id,
    slug: id,
    status: options.status ?? 'PUBLISHED',
    stock: options.stock ?? 1,
    preorderEnabled: options.preorderEnabled ?? false,
    preorderLimit: options.preorderLimit ?? 0,
    preorderReserved: options.preorderReserved ?? 0,
    categoryId: options.categoryId ?? 'category-a',
    category: {
      id: options.categoryId ?? 'category-a',
      parentId: 'parent',
      active: options.active ?? true,
      name: { en: 'Clothing' },
      slug: options.categoryId ?? 'category-a',
    },
    translations: { en: { title: id } },
    attributes: null,
    material: null,
    variants: [{ color: null, active: true, stock: options.variantStock ?? 1 }],
    createdAt: options.createdAt ?? new Date('2026-09-01T00:00:00.000Z'),
    publishedAt: options.createdAt ?? new Date('2026-09-01T00:00:00.000Z'),
    reviews: options.rating ? [{ rating: options.rating }] : [],
  };
}

describe('recommendation ranking', () => {
  it('filters unpublished, hidden-category, unavailable, and exhausted-preorder products', () => {
    const purchasable = product('stock');
    const preorder = product('preorder', {
      stock: 0,
      variantStock: 0,
      preorderEnabled: true,
      preorderLimit: 5,
      preorderReserved: 3,
    });
    const candidates = [
      purchasable,
      preorder,
      product('draft', { status: 'DRAFT' }),
      product('hidden-category', { active: false }),
      product('unavailable', { stock: 0, variantStock: 0 }),
      product('preorder-full', {
        stock: 0,
        variantStock: 0,
        preorderEnabled: true,
        preorderLimit: 2,
        preorderReserved: 2,
      }),
    ];

    expect(candidates.filter(isEligibleRecommendationProduct).map(({ id }) => id))
      .toEqual(['stock', 'preorder']);
  });

  it('excludes the current product and deduplicates canonical products', () => {
    const current = product('current');
    const recommendations = rankRecommendations(
      [current, product('candidate'), { ...product('candidate'), slug: 'duplicate-slug' }],
      {
        strategy: 'RELATED',
        baseProductId: current.id,
        baseCategoryId: current.categoryId,
        baseParentCategoryId: 'parent',
      },
    );

    expect(recommendations.map(({ product: item }) => item.id)).toEqual(['candidate']);
  });

  it('uses actual view and favorite signals for personalization while excluding viewed products', () => {
    const result = rankRecommendations(
      [
        product('viewed'),
        product('favorite', { categoryId: 'category-b' }),
        product('unrelated', { categoryId: 'category-c' }),
      ],
      {
        strategy: 'PERSONALIZED',
        viewedProductIds: new Set(['viewed']),
        interestedCategoryIds: new Set(['category-b']),
        favoriteProductIds: new Set(['favorite']),
      },
    );

    expect(result.map(({ product: item, reasonCode }) => [item.id, reasonCode])).toContainEqual([
      'favorite',
      'BASED_ON_YOUR_INTERESTS',
    ]);
    expect(result.map(({ product: item }) => item.id)).not.toContain('viewed');
  });
});
