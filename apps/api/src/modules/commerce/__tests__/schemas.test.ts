import { describe, expect, it } from 'vitest';
import {
  approveImportSchema,
  createManualProductSchema,
  productListQuerySchema,
  updateManualProductSchema,
} from '../schemas';
import { buildProductWhere } from '../index';

const manualProduct = {
  title: 'Test product',
  sourceUrl: 'https://example.com/product',
  salePriceUzs: 180000,
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

  it('requires a supported country when approving an imported product', () => {
    const approval = { salePriceUzs: 180000, exchangeRate: 1800, publish: true };
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

  it.each(['CN', 'US', 'TR', 'IT', 'GB'])('builds a database filter for %s with other list params intact', (country) => {
    const query = productListQuerySchema.parse({ country, page: '2', limit: '15', q: 'coat' });
    const where = buildProductWhere(query, 'PUBLISHED');

    expect(where).toMatchObject({
      country,
      status: 'PUBLISHED',
      OR: [
        { id: { equals: 'coat' } },
        { slug: { contains: 'coat', mode: 'insensitive' } },
        { material: { contains: 'coat', mode: 'insensitive' } },
      ],
    });
    expect(query.page).toBe('2');
    expect(query.limit).toBe('15');
  });

  it('does not add a country condition when no country was selected', () => {
    expect(buildProductWhere(productListQuerySchema.parse({}))).not.toHaveProperty('country');
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
      sourceUrl: 'https://example.com/product',
      salePriceUzs: 750000,
      categoryId: null,
    }).success).toBe(true);
    expect(updateManualProductSchema.safeParse({ salePriceUzs: 0 }).success).toBe(false);
    expect(updateManualProductSchema.safeParse({}).success).toBe(false);
  });
});
