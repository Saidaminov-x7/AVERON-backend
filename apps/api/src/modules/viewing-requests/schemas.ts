// apps/api/src/modules/viewing-requests/schemas.ts

import { z } from 'zod';
import { ViewingStatus } from '@prisma/client';

export const createViewingRequestSchema = z.object({
  preferredDate: z.string().optional(),
  message: z.string().max(1000).optional(),
});

export type CreateViewingRequestDto = z.infer<typeof createViewingRequestSchema>;

export const updateViewingStatusSchema = z.object({
  status: z.nativeEnum(ViewingStatus),
});

export type UpdateViewingStatusDto = z.infer<typeof updateViewingStatusSchema>;
