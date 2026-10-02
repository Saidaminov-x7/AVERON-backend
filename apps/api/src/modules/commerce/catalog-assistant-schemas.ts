import { z } from 'zod';

const colorAliases: Record<string, string[]> = {
  black: ['black', 'черн', 'qora'],
  white: ['white', 'бел', 'oq'],
  beige: ['beige', 'беж', 'bej'],
  brown: ['brown', 'коричнев', 'jigarrang'],
  blue: ['blue', 'син', 'koʻk', 'kok'],
  red: ['red', 'красн', 'qizil'],
  green: ['green', 'зелен', 'yashil'],
  pink: ['pink', 'розов', 'pushti'],
};

export function normalizeCatalogColor(value: string): string {
  const normalized = value.toLocaleLowerCase().replace(/[’‘`']/g, '').trim();
  return Object.entries(colorAliases)
    .find(([, aliases]) => aliases.some((alias) => normalized.startsWith(alias.replace(/[’‘`']/g, ''))))
    ?.[0] ?? normalized;
}

export function catalogColorTerms(value: string): string[] {
  const normalized = normalizeCatalogColor(value);
  return colorAliases[normalized] ?? [normalized];
}

const priceUzs = z.number().int().min(0).max(100_000_000);
const slug = z.string().trim().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/i);
const boundedText = z.string().trim().min(1).max(500);

export const searchIntentSchema = z.object({
  query: z.string().trim().max(120).optional(),
  category: slug.optional(),
  gender: z.enum(['men', 'women', 'kids']).optional(),
  colors: z.array(z.string().trim().min(1).max(32)).max(5).optional(),
  sizes: z.array(z.string().trim().min(1).max(24)).max(8).optional(),
  styles: z.array(z.enum(['casual', 'old_money', 'minimalist', 'formal', 'streetwear', 'evening', 'sport', 'classic'])).max(5).optional(),
  season: z.array(z.enum(['spring', 'summer', 'autumn', 'winter'])).max(4).optional(),
  minPrice: priceUzs.optional(),
  maxPrice: priceUzs.optional(),
  sort: z.enum(['newest', 'price_asc', 'price_desc']).optional(),
  inStockOnly: z.boolean().optional(),
  preorderAllowed: z.boolean().optional(),
}).strict().superRefine((intent, context) => {
  if (intent.minPrice !== undefined && intent.maxPrice !== undefined && intent.minPrice > intent.maxPrice) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['maxPrice'], message: 'maxPrice must be greater than or equal to minPrice' });
  }
});

export const searchOverrideSchema = z.object({
  category: slug.nullable().optional(),
  gender: z.enum(['men', 'women', 'kids']).nullable().optional(),
  colors: z.array(z.string().trim().min(1).max(32)).max(5).optional(),
  sizes: z.array(z.string().trim().min(1).max(24)).max(8).optional(),
  minPrice: priceUzs.nullable().optional(),
  maxPrice: priceUzs.nullable().optional(),
}).strict();

export const searchRequestSchema = z.object({
  query: boundedText,
  locale: z.enum(['ru', 'uz', 'en']).default('ru'),
  overrides: searchOverrideSchema.optional(),
}).strict();

export const styleIntentSchema = z.object({
  occasion: z.string().trim().max(80).optional(),
  style: z.enum(['casual', 'old_money', 'minimalist', 'formal', 'streetwear', 'evening', 'sport', 'classic', 'unknown']).optional(),
  season: z.enum(['spring', 'summer', 'autumn', 'winter']).optional(),
  gender: z.enum(['men', 'women', 'kids']).optional(),
  budgetUzs: priceUzs.optional(),
  preferredColors: z.array(z.string().trim().min(1).max(32)).max(5).optional(),
  excludedColors: z.array(z.string().trim().min(1).max(32)).max(5).optional(),
  sizes: z.array(z.string().trim().min(1).max(24)).max(8).optional(),
  requiredCategories: z.array(z.enum(['top', 'bottom', 'shoes', 'outerwear', 'accessory', 'dress', 'bag'])).max(7).optional(),
  excludedCategories: z.array(z.enum(['top', 'bottom', 'shoes', 'outerwear', 'accessory', 'dress', 'bag'])).max(7).optional(),
  preorderAllowed: z.boolean().default(false),
}).strict();

export const styleRequestSchema = z.object({
  prompt: boundedText,
  locale: z.enum(['ru', 'uz', 'en']).default('ru'),
  baseProductSlug: slug.optional(),
}).strict();

export type SearchIntent = z.infer<typeof searchIntentSchema>;
export type SearchOverrides = z.infer<typeof searchOverrideSchema>;
export type StyleIntent = z.infer<typeof styleIntentSchema>;
