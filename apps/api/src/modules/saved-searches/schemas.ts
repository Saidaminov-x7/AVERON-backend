// apps/api/src/modules/saved-searches/schemas.ts

import { z } from 'zod';

export const createSavedSearchSchema = z.object({
  name: z.string().min(2).max(100),
  filters: z.object({
    city: z.string().optional(),
    district: z.string().optional(),
    minPrice: z.number().positive().optional(),
    maxPrice: z.number().positive().optional(),
    rooms: z.number().int().min(0).optional(),
    type: z.string().optional(),
    amenities: z.array(z.string()).optional(),
  }),
});

export type CreateSavedSearchDto = z.infer<typeof createSavedSearchSchema>;
