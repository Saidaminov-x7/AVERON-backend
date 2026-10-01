import { z } from 'zod';
import { ProductCountry, ProductPublicationStatus } from '@prisma/client';

export const productCountrySchema = z.nativeEnum(ProductCountry);

export const productListQuerySchema = z.object({
  q: z.string().optional(),
  country: productCountrySchema.optional(),
  category: z.string().optional(),
  audience: z.string().optional(),
  size: z.string().optional(),
  color: z.string().optional(),
  minPrice: z.string().optional(),
  maxPrice: z.string().optional(),
  sort: z.string().optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
});

export const adminProductListQuerySchema = productListQuerySchema.extend({
  status: z.nativeEnum(ProductPublicationStatus).optional(),
});

export const createImportSchema = z.object({
  source: z.enum(['SOURCE_1688', 'TAOBAO', 'ALIBABA', 'ALIEXPRESS', 'MANUAL']),
  sourceProductId: z.string().min(1).max(160),
  sourceUrl: z.string().url(),
  sellerId: z.string().max(160).optional(),
  originalTitle: z.string().min(1).max(500),
  sourcePriceCny: z.coerce.number().nonnegative(),
  normalizedPayload: z.record(z.string(), z.unknown()),
  aiPayload: z.record(z.string(), z.unknown()).optional(),
  aiWarnings: z.array(z.string()).optional(),
  suggestedPriceUzs: z.coerce.number().positive().optional(),
  expectedCostUzs: z.coerce.number().nonnegative().optional(),
  categoryId: z.string().uuid().optional(),
});

export const approveImportSchema = z.object({
  translations: z.record(z.string(), z.unknown()).optional(),
  country: productCountrySchema,
  salePriceUzs: z.coerce.number().finite().positive(),
  exchangeRate: z.coerce.number().positive(),
  publish: z.boolean().default(true),
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
  titleUz: z.string().min(2).max(500),
  titleEn: z.string().min(2).max(500),
  description: z.string().max(5000).optional(),
  descriptionUz: z.string().max(5000).optional(),
  descriptionEn: z.string().max(5000).optional(),
  sourceUrl: z.string().url().optional().nullable(),
  images: createProductImagesSchema,
  sourcePriceCny: z.coerce.number().finite().nonnegative().optional(),
  exchangeRate: z.coerce.number().finite().positive().optional(),
  salePriceUzs: z.coerce.number().finite().positive(),
  categoryId: z.string().uuid().optional(),
  color: z.string().max(80).optional(),
  size: z.string().max(80).optional(),
  publish: z.boolean().default(true),
});

export const updateManualProductSchema = z.object({
  country: productCountrySchema.optional(),
  title: z.string().min(2).max(500).optional(),
  titleUz: z.string().max(500).optional(),
  titleEn: z.string().max(500).optional(),
  description: z.string().max(5000).optional(),
  descriptionUz: z.string().max(5000).optional(),
  descriptionEn: z.string().max(5000).optional(),
  sourceUrl: z.string().url().nullable().optional(),
  images: productImagesSchema.optional(),
  salePriceUzs: z.coerce.number().finite().positive().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  color: z.string().max(80).optional(),
  size: z.string().max(80).optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one product field must be provided',
});

const localizedCategoryNameSchema = z.object({
  ru: z.string().trim().min(1).max(120),
  uz: z.string().trim().min(1).max(120),
  en: z.string().trim().min(1).max(120),
});

export const createCategorySchema = z.object({
  slug: z.string().trim().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: localizedCategoryNameSchema,
  parentId: z.string().uuid().nullable().optional(),
  sortOrder: z.coerce.number().int().min(0).max(10000).optional(),
});

export const updateCategorySchema = z.object({
  slug: z.string().trim().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  name: localizedCategoryNameSchema.partial().optional(),
  parentId: z.string().uuid().nullable().optional(),
  sortOrder: z.coerce.number().int().min(0).max(10000).optional(),
  active: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one category field must be provided',
});

export const customOrderSchema = z.object({
  source: z.enum(['SOURCE_1688', 'TAOBAO', 'ALIBABA', 'ALIEXPRESS']).default('SOURCE_1688'),
  sourceUrl: z.string().url(),
  selectedVariant: z.record(z.string(), z.unknown()).optional(),
  quantity: z.coerce.number().int().min(1).max(100).default(1),
  contact: z.object({ name: z.string().min(2), phone: z.string().min(7), note: z.string().max(1000).optional() }),
});
