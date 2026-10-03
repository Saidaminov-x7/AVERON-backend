// apps/api/src/modules/admin/schemas.ts
// Zod-схемы для всех admin-эндпоинтов

import { z } from 'zod';
import { ModerationStatus, Role, ListingStatus } from '@prisma/client';

// ─── Объявления ───────────────────────────────────────────────────────────────

export const adminListingsFilterSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  status: z.nativeEnum(ListingStatus).optional(),
  moderationStatus: z.nativeEnum(ModerationStatus).optional(),
  city: z.string().optional(),
  ownerId: z.string().uuid().optional(),
  dateFrom: z.string().optional(), // ISO date
  dateTo: z.string().optional(),
  sortBy: z.enum(['createdAt', 'price', 'viewsCount', 'area']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type AdminListingsFilterDto = z.infer<typeof adminListingsFilterSchema>;

export const rejectListingSchema = z.object({
  reason: z.string().min(5, 'Причина отклонения обязательна (мин. 5 символов)').max(500),
});

export const requestChangesSchema = z.object({
  comment: z.string().min(5, 'Комментарий обязателен (мин. 5 символов)').max(1000),
});

// ─── Пользователи ─────────────────────────────────────────────────────────────

export const adminUsersFilterSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  role: z.enum(['USER', 'LANDLORD', 'ADMIN', 'TENANT']).optional(),
  isBlocked: z.coerce.boolean().optional(),
  isStaff: z.coerce.boolean().optional(), // Только персонал (ADMIN + adminRole не null)
  city: z.string().optional(),
  search: z.string().optional(), // поиск по name/email/phone
  dateFrom: z.string().optional(), // ISO date (YYYY-MM-DD)
  dateTo: z.string().optional(), // ISO date (YYYY-MM-DD)
  lastActiveDays: z.coerce.number().int().positive().optional(), // для метрики активных
  createdAfterDays: z.coerce.number().int().positive().optional(), // для метрики новых
  createdBeforeDays: z.coerce.number().int().positive().optional(),
  sortBy: z.enum(['createdAt', 'name', 'email']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  order: z.enum(['asc', 'desc']).optional(),
});

export type AdminUsersFilterDto = z.infer<typeof adminUsersFilterSchema>;

export const blockUserSchema = z.object({
  reason: z.string().min(3, 'Причина блокировки обязательна').max(500).optional(),
});

export const changeRoleSchema = z.object({
  role: z.nativeEnum(Role),
});

// ─── Страницы (динамические) ──────────────────────────────────────────────────

export const createPageSchema = z.object({
  slug: z.string().min(2).max(100).regex(/^[a-z0-9-]+$/, 'Slug: только строчные буквы, цифры и тире'),
  title: z.string().min(2).max(200),
  content: z.string().min(1).max(50000),
  locale: z.enum(['ru', 'uz', 'en']).default('ru'),
  isPublished: z.boolean().default(false),
});

export type CreatePageDto = z.infer<typeof createPageSchema>;

export const updatePageSchema = createPageSchema.partial();
export type UpdatePageDto = z.infer<typeof updatePageSchema>;

// ─── Настройки сайта ──────────────────────────────────────────────────────────

export const updateSiteSettingsSchema = z.object({
  maintenanceMode: z.boolean().optional(),
  maintenanceMessage: z.string().max(500).optional().nullable(),
  siteName: z.string().min(2).max(100).optional(),
  contactEmail: z.union([z.string().email(), z.literal('')]).optional(),
  contactPhone: z.union([z.string().min(5).max(30), z.literal('')]).optional(),
  googleAuthEnabled: z.boolean().optional(),
  autoModerationEnabled: z.boolean().optional(),
  maxImagesPerListing: z.coerce.number().int().min(1).max(50).optional(),
  maxProductPhotos: z.coerce.number().int().min(1).max(15).optional(),
  maxProductPhotoSizeMb: z.coerce.number().int().min(1).max(25).optional(),
  logoUrl: z.string().url().optional().nullable(),

  // Feature Flags & Integrations
  deviceIpBanEnabled: z.boolean().optional(),
  adaptiveRateLimitEnabled: z.boolean().optional(),
  twoFactorAuthEnabled: z.boolean().optional(),
  geoIpValidationEnabled: z.boolean().optional(),
  tokenRotationEnabled: z.boolean().optional(),
  fieldEncryptionEnabled: z.boolean().optional(),
  sessionQuarantineEnabled: z.boolean().optional(),
  thunderingHerdEnabled: z.boolean().optional(),
  fullTextSearchEnabled: z.boolean().optional(),
  paymeClickEnabled: z.boolean().optional(),
  autoFiscalizationEnabled: z.boolean().optional(),
  smsGatewayEnabled: z.boolean().optional(),
  watermarkDetectorEnabled: z.boolean().optional(),
  webPushEnabled: z.boolean().optional(),
  oneIdAuthEnabled: z.boolean().optional(),
  openTelemetryEnabled: z.boolean().optional(),
  yandexMetrikaId: z.string().max(50).optional(),
  yandexMetrikaEnabled: z.boolean().optional(),
  navLinks: z.array(
    z.object({
      label: z.string().min(1),
      href: z.string().min(1),
      position: z.enum(['header', 'footer']),
    })
  ).optional().nullable(),
  maintenancePasswordEnabled: z.boolean().optional(),
  maintenanceBypassPassword: z.string().max(100).optional().nullable(),
  mobilePinchZoomEnabled: z.boolean().optional(),
});

export type UpdateSiteSettingsDto = z.infer<typeof updateSiteSettingsSchema>;

// ─── Статистика ───────────────────────────────────────────────────────────────

export const trafficFilterSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  from: z.string().optional(),
  to: z.string().optional(),
});
