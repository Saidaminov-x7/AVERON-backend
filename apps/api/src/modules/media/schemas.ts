// apps/api/src/modules/media/schemas.ts

import { z } from 'zod';

export const uploadQuerySchema = z.object({
  listingId: z.string().uuid().optional(),
});

export type UploadQueryDto = z.infer<typeof uploadQuerySchema>;

export const mediaListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(24),
  mimeType: z.string().optional(),
});

export type MediaListQueryDto = z.infer<typeof mediaListQuerySchema>;

export const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
