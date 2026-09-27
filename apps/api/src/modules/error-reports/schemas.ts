import { z } from 'zod';

export const createErrorReportSchema = z.object({
  message: z.string().min(1).max(2000),
  stack: z.string().max(5000).optional().nullable(),
  url: z.string().max(500),
  userAgent: z.string().max(500).optional().nullable(),
  userId: z.string().optional().nullable(),
  severity: z.enum(['error', 'warning', 'info']).default('error'),
});

export type CreateErrorReportDto = z.infer<typeof createErrorReportSchema>;

export const errorReportFilterSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  severity: z.enum(['error', 'warning', 'info']).optional(),
  resolved: z
    .enum(['true', 'false', 'all'])
    .optional()
    .transform((val) => (val === 'true' ? true : val === 'false' ? false : undefined)),
});

export type ErrorReportFilterDto = z.infer<typeof errorReportFilterSchema>;
