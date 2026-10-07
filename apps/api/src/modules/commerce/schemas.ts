import { z } from 'zod';
import { ProductCountry, ProductPublicationStatus, ProductSource } from '@prisma/client';
import { isIP } from 'node:net';

export const productCountrySchema = z.nativeEnum(ProductCountry);

export const productSizeChartSchema = z.array(z.object({
  size: z.string().trim().min(1).max(32),
  shouldersCm: z.number().finite().min(10).max(100).optional(),
  chestCm: z.number().finite().min(20).max(200).optional(),
  lengthCm: z.number().finite().min(20).max(250).optional(),
  sleeveCm: z.number().finite().min(10).max(150).optional(),
  waistCm: z.number().finite().min(20).max(200).optional(),
  hipsCm: z.number().finite().min(20).max(220).optional(),
  inseamCm: z.number().finite().min(10).max(160).optional(),
  recommendedHeightMinCm: z.number().int().min(80).max(250).optional(),
  recommendedHeightMaxCm: z.number().int().min(80).max(250).optional(),
  recommendedWeightMinKg: z.number().int().min(20).max(300).optional(),
  recommendedWeightMaxKg: z.number().int().min(20).max(300).optional(),
})).max(40).superRefine((rows, context) => {
  const sizes = new Set<string>();
  rows.forEach((row, index) => {
    if (sizes.has(row.size.toLocaleLowerCase())) context.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'size'], message: 'Size labels must be unique' });
    sizes.add(row.size.toLocaleLowerCase());
    if (row.recommendedHeightMinCm !== undefined && row.recommendedHeightMaxCm !== undefined && row.recommendedHeightMinCm > row.recommendedHeightMaxCm) context.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'recommendedHeightMaxCm'], message: 'Maximum recommended height must not be below minimum' });
    if (row.recommendedWeightMinKg !== undefined && row.recommendedWeightMaxKg !== undefined && row.recommendedWeightMinKg > row.recommendedWeightMaxKg) context.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'recommendedWeightMaxKg'], message: 'Maximum recommended weight must not be below minimum' });
  });
});

const safeSourceUrlSchema = z.string().url().max(2048).refine((value) => {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  return url.protocol === 'https:'
    && !url.username
    && !url.password
    && !isIP(hostname.replace(/^\[|\]$/g, ''))
    && !/(?:^|\.)localhost$/.test(hostname)
    && !/(?:^|\.)(?:local|internal|lan|home\.arpa)$/.test(hostname);
}, 'Source URL must be a public HTTPS URL');

const sourceDomains: Partial<Record<ProductSource, string[]>> = {
  SOURCE_1688: ['1688.com'],
  TAOBAO: ['taobao.com', 'tmall.com'],
  ALIBABA: ['alibaba.com'],
  ALIEXPRESS: ['aliexpress.com'],
};

function isHostForProvider(hostname: string, provider: ProductSource): boolean {
  const domains = sourceDomains[provider];
  return !domains || domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

const productPriceQuerySchema = z.string()
  .regex(/^\d{1,14}(?:\.\d{1,2})?$/, 'Price must be a nonnegative UZS amount');
const optionalQueryValue = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => value === '' ? undefined : value, schema.optional());

const productListQueryBaseSchema = z.object({
  q: z.string().trim().max(200).optional(),
  country: optionalQueryValue(productCountrySchema),
  category: optionalQueryValue(z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120)),
  audience: optionalQueryValue(z.enum(['everyone', 'women', 'men', 'kids'])),
  size: optionalQueryValue(z.string().trim().min(1).max(32)),
  color: optionalQueryValue(z.string().trim().min(1).max(48)),
  minPrice: optionalQueryValue(productPriceQuerySchema),
  maxPrice: optionalQueryValue(productPriceQuerySchema),
  sort: z.enum(['newest', 'price_asc', 'price_desc', 'popular']).optional(),
  page: z.string().regex(/^[1-9]\d{0,5}$/).optional(),
  limit: z.string().regex(/^[1-9]\d{0,2}$/).optional(),
});

function validateProductPriceRange(
  query: { minPrice?: string; maxPrice?: string },
  context: z.RefinementCtx,
) {
  if (query.minPrice !== undefined && query.maxPrice !== undefined && Number(query.minPrice) > Number(query.maxPrice)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxPrice'],
      message: 'Maximum price must be greater than or equal to minimum price',
    });
  }
}

export const productListQuerySchema = productListQueryBaseSchema.superRefine(validateProductPriceRange);

export const adminProductListQuerySchema = productListQueryBaseSchema.extend({
  status: z.nativeEnum(ProductPublicationStatus).optional(),
  source: z.nativeEnum(ProductSource).optional(),
}).superRefine(validateProductPriceRange);

export const adminImportListQuerySchema = z.object({
  status: z.enum(['PENDING_REVIEW', 'APPROVED', 'REJECTED']).optional(),
  provider: z.enum(['SOURCE_1688', 'TAOBAO', 'ALIBABA', 'ALIEXPRESS', 'MANUAL']).optional(),
  country: productCountrySchema.optional(),
  q: z.string().trim().max(200).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const boundedImportMetadataSchema = z.record(z.string().max(100), z.unknown()).superRefine((value, context) => {
  if (Object.keys(value).length > 100) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'At most 100 source attributes are allowed' });
  }
});

export const parserImportProductV1Schema = z.object({
  schemaVersion: z.number().int(),
  provider: z.enum(['SOURCE_1688', 'PINDUODUO']),
  sourceProductId: z.string().trim().min(1).max(160),
  deduplicationKey: z.string().trim().min(1).max(320),
  sourceUrl: safeSourceUrlSchema,
  sourceTitle: z.string().trim().min(1).max(500),
  sourceDescription: z.string().max(8000).optional(),
  sourceImages: z.array(z.string().url().max(2048).refine((value) => new URL(value).protocol === 'https:', 'Image URL must use HTTPS')).max(15).default([]),
  sourcePrice: z.object({
    amount: z.number().finite().nonnegative(),
    currency: z.literal('CNY'),
  }).optional(),
  sourceCategory: z.string().trim().max(200).optional(),
  country: productCountrySchema,
  sourceAttributes: z.record(z.string().max(100), z.union([
    z.string().max(500),
    z.array(z.string().max(500)).max(30),
  ])).default({}),
  variants: z.array(z.object({
    sourceVariantId: z.string().max(160).optional(),
    color: z.string().max(80).optional(),
    size: z.string().max(80).optional(),
    sourcePriceCny: z.number().finite().nonnegative().optional(),
  })).max(100).default([]),
  sizes: z.array(z.string().max(80)).max(100).default([]),
  fetchedAt: z.string().datetime(),
  rawMetadata: boundedImportMetadataSchema.optional(),
}).superRefine((value, context) => {
  if (value.deduplicationKey !== `${value.provider}:${value.sourceProductId}`) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deduplicationKey'],
      message: 'deduplicationKey must match the provider and source product ID',
    });
  }
  if (value.schemaVersion !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['schemaVersion'],
      message: 'Unsupported parser import schema version',
    });
  }
  const hostname = new URL(value.sourceUrl).hostname.toLowerCase().replace(/\.$/, '');
  if (value.provider === 'SOURCE_1688') {
    if (hostname !== 'detail.1688.com' || !/^\/offer\/[^/]+\.html$/i.test(new URL(value.sourceUrl).pathname)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceUrl'],
        message: 'SOURCE_1688 imports must use a supported product detail URL',
      });
    }
  } else if (
    hostname !== 'pinduoduo.com'
    && !hostname.endsWith('.pinduoduo.com')
    && hostname !== 'yangkeduo.com'
    && !hostname.endsWith('.yangkeduo.com')
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceUrl'],
      message: 'PINDUODUO imports must use a supported marketplace domain',
    });
  }
  if (value.rawMetadata && Buffer.byteLength(JSON.stringify(value.rawMetadata), 'utf8') > 12 * 1024) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['rawMetadata'], message: 'Source metadata exceeds the 12 KB limit' });
  }
});

export const createImportSchema = z.object({
  source: z.enum(['SOURCE_1688', 'TAOBAO', 'ALIBABA', 'ALIEXPRESS', 'MANUAL']),
  sourceProvider: z.enum(['SOURCE_1688', 'TAOBAO', 'ALIBABA', 'ALIEXPRESS', 'MANUAL']).optional(),
  sourceProductId: z.string().min(1).max(160),
  sourceUrl: safeSourceUrlSchema,
  sourceMetadata: z.record(z.string(), z.unknown()).optional(),
  deduplicationKey: z.string().min(1).max(320).optional(),
  sellerId: z.string().max(160).optional(),
  originalTitle: z.string().min(1).max(500),
  sourcePriceCny: z.coerce.number().nonnegative(),
  normalizedPayload: z.record(z.string(), z.unknown()),
  aiPayload: z.record(z.string(), z.unknown()).optional(),
  aiWarnings: z.array(z.string()).optional(),
  suggestedPriceUzs: z.coerce.number().positive().optional(),
  expectedCostUzs: z.coerce.number().nonnegative().optional(),
  categoryId: z.string().uuid().optional(),
}).superRefine((value, context) => {
  if (value.source !== 'MANUAL') {
    const hostname = new URL(value.sourceUrl).hostname.toLowerCase().replace(/\.$/, '');
    if (!isHostForProvider(hostname, value.source)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceUrl'],
        message: 'Source URL does not match the selected provider',
      });
    }
  }
  if (value.sourceProvider && value.sourceProvider !== value.source) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceProvider'],
      message: 'sourceProvider must match source',
    });
  }
  const expectedDeduplicationKey = `${value.source}:${value.sourceProductId}`;
  if (value.deduplicationKey && value.deduplicationKey !== expectedDeduplicationKey) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deduplicationKey'],
      message: 'deduplicationKey must match the source and source product ID',
    });
  }
});

export const approveImportSchema = z.object({
  translations: z.object({
    ru: z.object({
      title: z.string().trim().min(2).max(500).optional(),
      description: z.string().max(5000).optional(),
      characteristics: z.record(z.string().trim().min(1).max(120), z.string().trim().max(500)).optional(),
    }).partial(),
    uz: z.object({
      title: z.string().trim().min(2).max(500).optional(),
      description: z.string().max(5000).optional(),
      characteristics: z.record(z.string().trim().min(1).max(120), z.string().trim().max(500)).optional(),
    }).partial(),
    en: z.object({
      title: z.string().trim().min(2).max(500).optional(),
      description: z.string().max(5000).optional(),
      characteristics: z.record(z.string().trim().min(1).max(120), z.string().trim().max(500)).optional(),
    }).partial(),
  }).partial().optional(),
  country: productCountrySchema,
  sizeChartType: z.enum(['CLOTHING', 'SHOES', 'KIDS_CLOTHING']).nullable().optional(),
  sizeChart: productSizeChartSchema.optional(),
  salePriceUzs: z.coerce.number().finite().positive(),
  exchangeRate: z.coerce.number().finite().positive().optional(),
  mediaIds: z.array(z.string().uuid()).max(15).default([]),
  publish: z.boolean().default(false),
}).superRefine((value, context) => {
  if (value.publish && value.mediaIds.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mediaIds'],
      message: 'A product must have at least one AVERON media image before publication',
    });
  }
});

export const rejectImportSchema = z.object({ reason: z.string().min(3).max(500) });

const productImageReferenceSchema = z.object({
  id: z.string().uuid().optional(),
  mediaId: z.string().uuid().optional(),
}).refine(({ id, mediaId }) => Boolean(id) !== Boolean(mediaId), {
  message: 'Each image must reference either an existing product image or a media upload',
});

const productImagesSchema = z.array(productImageReferenceSchema).min(1).max(15)
  .superRefine((images, context) => {
    const references = images.map(({ id, mediaId }) => id ?? mediaId);
    if (new Set(references).size !== references.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Product images must be unique' });
    }
  });

const createProductImagesSchema = z.array(z.object({ mediaId: z.string().uuid() })).min(1).max(15)
  .superRefine((images, context) => {
    const mediaIds = images.map(({ mediaId }) => mediaId);
    if (new Set(mediaIds).size !== mediaIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Product images must be unique' });
    }
  });

export const createManualProductSchema = z.object({
  title: z.string().min(2).max(500),
  country: productCountrySchema,
  sizeChartType: z.enum(['CLOTHING', 'SHOES', 'KIDS_CLOTHING']).nullable().optional(),
  sizeChart: productSizeChartSchema.optional(),
  titleUz: z.string().min(2).max(500),
  titleEn: z.string().min(2).max(500),
  description: z.string().max(5000).optional(),
  descriptionUz: z.string().max(5000).optional(),
  descriptionEn: z.string().max(5000).optional(),
  sourceUrl: safeSourceUrlSchema.optional().nullable(),
  images: createProductImagesSchema,
  sourcePriceCny: z.coerce.number().finite().nonnegative().optional(),
  exchangeRate: z.coerce.number().finite().positive().optional(),
  salePriceUzs: z.coerce.number().finite().positive(),
  compareAtPriceUzs: z.coerce.number().finite().positive().nullable().optional(),
  stock: z.number().int().min(0).max(2_147_483_647).default(0),
  preorderEnabled: z.boolean().default(false),
  preorderLimit: z.number().int().min(0).max(10_000).default(0),
  preorderEstimatedAt: z.string().datetime({ offset: true }).nullable().optional()
    .transform((value) => value ? new Date(value) : value),
  categoryId: z.string().uuid().optional(),
  color: z.string().max(80).optional(),
  colors: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    hex: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
  })).max(30).optional(),
  size: z.string().max(80).optional(),
  publish: z.boolean().default(true),
}).superRefine((value, context) => {
  if (value.preorderEnabled && value.preorderLimit < 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['preorderLimit'],
      message: 'Enabled preorder requires a positive bounded quantity',
    });
  }
});

export const updateManualProductSchema = z.object({
  country: productCountrySchema.optional(),
  sizeChartType: z.enum(['CLOTHING', 'SHOES', 'KIDS_CLOTHING']).nullable().optional(),
  sizeChart: productSizeChartSchema.optional(),
  title: z.string().min(2).max(500).optional(),
  titleUz: z.string().max(500).optional(),
  titleEn: z.string().max(500).optional(),
  description: z.string().max(5000).optional(),
  descriptionUz: z.string().max(5000).optional(),
  descriptionEn: z.string().max(5000).optional(),
  sourceUrl: safeSourceUrlSchema.nullable().optional(),
  images: productImagesSchema.optional(),
  salePriceUzs: z.coerce.number().finite().positive().optional(),
  compareAtPriceUzs: z.coerce.number().finite().positive().nullable().optional(),
  stock: z.number().int().min(0).max(2_147_483_647).optional(),
  preorderEnabled: z.boolean().optional(),
  preorderLimit: z.number().int().min(0).max(10_000).optional(),
  preorderEstimatedAt: z.string().datetime({ offset: true }).nullable().optional()
    .transform((value) => value ? new Date(value) : value),
  categoryId: z.string().uuid().nullable().optional(),
  color: z.string().max(80).optional(),
  colors: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    hex: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
  })).max(30).optional(),
  size: z.string().max(80).optional(),
  publish: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one product field must be provided',
});

const localizedCategoryNameSchema = z.object({
  ru: z.string().trim().min(1).max(120),
  uz: z.string().trim().min(1).max(120),
  en: z.string().trim().min(1).max(120),
});

export const createCategorySchema = z.object({
  slug: z.string().trim().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  name: localizedCategoryNameSchema,
  parentId: z.string().uuid().nullable().optional(),
  sortOrder: z.coerce.number().int().min(0).max(10000).optional(),
  imageUrl: z.string().url().max(2000).nullable().optional(),
});

export const updateCategorySchema = z.object({
  slug: z.string().trim().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  name: localizedCategoryNameSchema.partial().optional(),
  parentId: z.string().uuid().nullable().optional(),
  sortOrder: z.coerce.number().int().min(0).max(10000).optional(),
  active: z.boolean().optional(),
  imageUrl: z.string().url().max(2000).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one category field must be provided',
});

export const customOrderSchema = z.object({
  source: z.enum(['SOURCE_1688', 'TAOBAO', 'ALIBABA', 'ALIEXPRESS']).default('SOURCE_1688'),
  sourceUrl: safeSourceUrlSchema,
  selectedVariant: z.record(z.string(), z.unknown()).optional(),
  quantity: z.coerce.number().int().min(1).max(100).default(1),
  contact: z.object({ name: z.string().min(2), phone: z.string().min(7), note: z.string().max(1000).optional() }),
});
