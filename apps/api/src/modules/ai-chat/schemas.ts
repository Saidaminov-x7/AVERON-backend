// apps/api/src/modules/ai-chat/schemas.ts

import { z } from 'zod';

export const sendMessageSchema = z.object({
  message: z.string().min(1).max(4000),
  sessionId: z.string().uuid().optional(),
  model: z.string().default('llama3'),
});

export type SendMessageDto = z.infer<typeof sendMessageSchema>;

export const createSessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});

export type CreateSessionDto = z.infer<typeof createSessionSchema>;
