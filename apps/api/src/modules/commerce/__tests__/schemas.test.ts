import { describe, expect, it } from 'vitest';
import {
  approveImportSchema,
  createCategorySchema,
  createImportSchema,
  createManualProductSchema,
  adminProductListQuerySchema,
  productListQuerySchema,
  updateManualProductSchema,
} from '../schemas';
import { buildProductWhere } from '../index';

const manualProduct = {
  title: 'Test product',
  titleUz: 'Sinov mahsuloti',
  titleEn: 'Test product',
  salePriceUzs: 180000,
  images: [{ mediaId: '00000000-0000-4000-8000-000000000001' }],
};

describe('commerce product country validation', () => {
  it.each(['CN', 'US', 'TR', 'IT', 'GB'])('accepts %s for manual products', (country) => {
    expect(createManualProductSchema.safeParse({ ...manualProduct, country }).success).toBe(true);
  });

  it('requires a supported country for manual product creation', () => {
    expect(createManualProductSchema.safeParse(manualProduct).success).toBe(false);
    expect(createManualProductSchema.safeParse({ ...manualProduct, country: 'FR' }).success).toBe(false);
  });

  it('accepts a UZS-only manual product without a fabricated CNY price or exchange rate', () => {
    expect(createManualProductSchema.safeParse({ ...manualProduct, country: 'CN' }).success).toBe(true);
    expect(createManualProductSchema.safeParse({
      ...manualProduct,
      country: 'CN',
      salePriceUzs: Number.POSITIVE_INFINITY,
    }).success).toBe(false);
  });

  it('validates manually managed stock as a nonnegative integer', () => {
    expect(createManualProductSchema.safeParse({ ...manualProduct, country: 'CN', stock: 0 }).success).toBe(true);
    expect(createManualProductSchema.safeParse({ ...manualProduct, country: 'CN', stock: -1 }).success).toBe(false);
    expect(updateManualProductSchema.safeParse({ stock: 1.5 }).success).toBe(false);
  });

  it('allows a manual product without sourceUrl and requires localized titles plus at least one photo', () => {
    const result = createManualProductSchema.safeParse({ ...manualProduct, country: 'CN' });
    expect(result.success).toBe(true);
    expect(createManualProductSchema.safeParse({
      ...manualProduct,
      country: 'CN',
      images: [],
    }).success).toBe(false);
    expect(createManualProductSchema.safeParse({
      ...manualProduct,
      country: 'CN',
      titleUz: '',
    }).success).toBe(false);
  });

  it('rejects more than the hard system maximum of 15 photos', () => {
    const images = Array.from({ length: 16 }, (_, index) => ({
      mediaId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    }));
    expect(createManualProductSchema.safeParse({ ...manualProduct, country: 'CN', images }).success).toBe(false);
  });

  it('requires a supported country when approving an imported product', () => {
    const approval = {
      salePriceUzs: 180000,
      exchangeRate: 1800,
      publish: true,
      mediaIds: ['00000000-0000-4000-8000-000000000002'],
    };
    expect(approveImportSchema.safeParse({ ...approval, country: 'CN' }).success).toBe(true);
    expect(approveImportSchema.safeParse(approval).success).toBe(false);
    expect(approveImportSchema.safeParse({ ...approval, country: 'FR' }).success).toBe(false);
    expect(approveImportSchema.parse({ ...approval, country: 'CN', slug: 'parser-slug' }))
      .not.toHaveProperty('slug');
  });

  it('accepts supported country filters and rejects invalid country query values', () => {
    expect(productListQuerySchema.parse({ country: 'US', page: '2' })).toMatchObject({
      country: 'US',
      page: '2',
    });
    expect(productListQuerySchema.safeParse({ country: 'FR' }).success).toBe(false);
  });

  it('accepts Admin product source filters and rejects unsupported providers', () => {
    expect(adminProductListQuerySchema.parse({ source: 'SOURCE_1688' }).source).toBe('SOURCE_1688');
    expect(adminProductListQuerySchema.safeParse({ source: 'UNKNOWN' }).success).toBe(false);
  });

  it.each(['CN', 'US', 'TR', 'IT', 'GB'])('builds a database filter for %s with other list params intact', (country) => {
    const query = productListQuerySchema.parse({ country, page: '2', limit: '15', q: 'coat' });
    const where = buildProductWhere(query, 'PUBLISHED');
    const andConditions = Array.isArray(where.AND) ? where.AND : [];

    expect(where).toMatchObject({ country, status: 'PUBLISHED' });
    expect(andConditions).toHaveLength(1);
    expect(andConditions[0]).toMatchObject({
      OR: expect.arrayContaining([
        { id: { equals: 'coat' } },
        { slug: { contains: 'coat', mode: 'insensitive' } },
        { material: { contains: 'coat', mode: 'insensitive' } },
        { translations: { path: ['ru', 'title'], string_contains: 'coat' } },
        { translations: { path: ['uz', 'title'], string_contains: 'coat' } },
        { translations: { path: ['en', 'title'], string_contains: 'coat' } },
      ]),
    });
    expect(query.page).toBe('2');
    expect(query.limit).toBe('15');
  });

  it('does not add a country condition when no country was selected', () => {
    expect(buildProductWhere(productListQuerySchema.parse({}))).not.toHaveProperty('country');
  });

  it('validates and combines supported catalog filters', () => {
    const query = productListQuerySchema.parse({
      q: 'coat',
      country: 'CN',
      category: 'outerwear',
      audience: 'women',
      size: 'M',
      color: 'black',
      minPrice: '100000',
      maxPrice: '500000',
      sort: 'price_asc',
      page: '2',
      limit: '12',
    });
    expect(query).toMatchObject({
      country: 'CN',
      category: 'outerwear',
      audience: 'women',
      size: 'M',
      color: 'black',
      minPrice: '100000',
      maxPrice: '500000',
      sort: 'price_asc',
    });
    expect(buildProductWhere(query, 'PUBLISHED')).toMatchObject({
      country: 'CN',
      status: 'PUBLISHED',
      category: { slug: 'outerwear', active: true },
      attributes: { path: ['audience'], equals: 'women' },
      variants: {
        some: { active: true, size: 'M', color: { equals: 'black', mode: 'insensitive' } },
      },
      salePriceUzs: { gte: '100000', lte: '500000' },
    });
  });

  it.each([
    { audience: 'unrecognized' },
    { sort: 'random' },
    { country: 'FR' },
    { minPrice: '-1' },
    { minPrice: '1e6' },
    { minPrice: '200', maxPrice: '100' },
    { page: '0' },
  ])('rejects invalid catalog query values %#', (query) => {
    expect(productListQuerySchema.safeParse(query).success).toBe(false);
  });

  it('does not restrict admin products to published status unless a status is selected', () => {
    const allStatuses = buildProductWhere(productListQuerySchema.parse({}));
    const publishedOnly = buildProductWhere(productListQuerySchema.parse({}), 'PUBLISHED');

    expect(allStatuses).not.toHaveProperty('status');
    expect(publishedOnly.status).toBe('PUBLISHED');
  });

  it('validates full product updates and remains compatible with country-only updates', () => {
    expect(updateManualProductSchema.safeParse({ country: 'GB' }).success).toBe(true);
    expect(updateManualProductSchema.safeParse({ country: 'FR' }).success).toBe(false);
    expect(updateManualProductSchema.safeParse({
      title: 'Updated title',
      titleUz: 'Yangi nom',
      titleEn: 'Updated title',
      description: 'Описание',
      descriptionUz: 'Tavsif',
      descriptionEn: 'Description',
      salePriceUzs: 750000,
      categoryId: null,
    }).success).toBe(true);
    expect(updateManualProductSchema.safeParse({ salePriceUzs: 0 }).success).toBe(false);
    expect(updateManualProductSchema.safeParse({}).success).toBe(false);
  });

  it('validates localized category fields and slug format', () => {
    expect(createCategorySchema.safeParse({
      slug: 'outerwear',
      name: { ru: 'Верхняя одежда', uz: 'Ustki kiyim', en: 'Outerwear' },
    }).success).toBe(true);
    expect(createCategorySchema.safeParse({
      name: { ru: 'Верхняя одежда', uz: 'Ustki kiyim', en: 'Outerwear' },
    }).success).toBe(true);
    expect(createCategorySchema.safeParse({
      slug: 'Upper Wear',
      name: { ru: 'Одежда', uz: 'Kiyim', en: 'Clothing' },
    }).success).toBe(false);
  });

  it('validates source-provider metadata and deterministic deduplication keys', () => {
    const payload = {
      source: 'SOURCE_1688',
      sourceProvider: 'SOURCE_1688',
      sourceProductId: 'source-123',
      sourceUrl: 'https://example.test/item/123',
      sourceMetadata: { seller: 'seller-1' },
      deduplicationKey: 'SOURCE_1688:source-123',
      originalTitle: 'Cotton jacket',
      sourcePriceCny: 25,
      normalizedPayload: { title: 'Cotton jacket' },
    };

    expect(createImportSchema.safeParse(payload).success).toBe(true);
    expect(createImportSchema.safeParse({ ...payload, sourceProvider: 'TAOBAO' }).success).toBe(false);
    expect(createImportSchema.safeParse({ ...payload, deduplicationKey: 'arbitrary-key' }).success).toBe(false);
  });
});
