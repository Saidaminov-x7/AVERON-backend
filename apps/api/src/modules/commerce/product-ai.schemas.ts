import { z } from 'zod';
import { ProductCountry } from '@prisma/client';

const factsSchema = z.record(z.string().trim().min(1).max(120), z.string().trim().max(500))
  .refine((facts) => Object.keys(facts).length <= 100, 'At most 100 characteristics are allowed')
  .default({});

export const productAiInputSchema = z.object({
  sourceTitle: z.string().trim().min(1).max(500),
  sourceDescription: z.string().max(5000).optional(),
  country: z.nativeEnum(ProductCountry),
  categoryName: z.string().trim().max(120).optional(),
  characteristics: factsSchema,
  variants: z.array(z.object({
    size: z.string().max(80).optional(),
    color: z.string().max(80).optional(),
  }).strict()).max(100).default([]),
}).strict();

const localizedSuggestionSchema = z.object({
  title: z.string().max(500).default(''),
  description: z.string().max(5000).default(''),
  characteristics: factsSchema,
}).strict();

export const productAiSuggestionSchema = z.object({
  ru: localizedSuggestionSchema,
  uz: localizedSuggestionSchema,
  en: localizedSuggestionSchema,
}).strict();

export type ProductAiInput = z.infer<typeof productAiInputSchema>;
export type ProductAiSuggestion = z.infer<typeof productAiSuggestionSchema>;
