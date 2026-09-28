import { z } from 'zod';

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
  slug: z.string().min(2).max(180).optional(),
  translations: z.record(z.string(), z.unknown()).optional(),
  salePriceUzs: z.coerce.number().positive(),
  exchangeRate: z.coerce.number().positive(),
  publish: z.boolean().default(true),
});

export const rejectImportSchema = z.object({ reason: z.string().min(3).max(500) });

export const createManualProductSchema = z.object({
  title: z.string().min(2).max(500),
  titleUz: z.string().max(500).optional(),
  titleEn: z.string().max(500).optional(),
  description: z.string().max(5000).optional(),
  sourceUrl: z.string().url(),
  imageUrl: z.string().url().optional(),
  sourcePriceCny: z.coerce.number().nonnegative(),
  exchangeRate: z.coerce.number().positive(),
  salePriceUzs: z.coerce.number().positive(),
  categoryId: z.string().uuid().optional(),
  color: z.string().max(80).optional(),
  size: z.string().max(80).optional(),
  publish: z.boolean().default(true),
});

export const customOrderSchema = z.object({
  source: z.enum(['SOURCE_1688', 'TAOBAO', 'ALIBABA', 'ALIEXPRESS']).default('SOURCE_1688'),
  sourceUrl: z.string().url(),
  selectedVariant: z.record(z.string(), z.unknown()).optional(),
  quantity: z.coerce.number().int().min(1).max(100).default(1),
  contact: z.object({ name: z.string().min(2), phone: z.string().min(7), note: z.string().max(1000).optional() }),
});
