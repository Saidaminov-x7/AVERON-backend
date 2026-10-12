// apps/api/src/config/env.ts

import 'dotenv/config';
import { isIP } from 'node:net';
import { z } from 'zod';
import { isDeniedRefreshSecret } from './secret-validation';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TRUST_PROXY_ADDRESSES: z
    .string()
    .default('')
    .transform((value) => value.split(',').map((entry) => entry.trim()).filter(Boolean)),

  // Database
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid PostgreSQL URL'),

  // Redis
  REDIS_URL: z.string().url('REDIS_URL must be a valid Redis URL'),

  // JWT
  JWT_SECRET: z.string().min(32, 'JWT_SECRET должен быть минимум 32 символа'),
  REFRESH_SECRET: z.string().min(32, 'REFRESH_SECRET must be at least 32 characters'),
  TOTP_ENCRYPTION_KEY: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().regex(/^[0-9a-fA-F]{64}$/, 'TOTP_ENCRYPTION_KEY must be 64 hex characters').optional(),
  ),
  GOOGLE_CLIENT_ID: z.string().optional(),

  // Telegram 2FA & Notification Bot
  TELEGRAM_TOKEN_2FA: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ADMIN_CHAT_ID: z.string().optional(),
  PARSER_IMPORT_TOKEN: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().min(32, 'PARSER_IMPORT_TOKEN must be at least 32 characters').optional(),
  ),

  // Public Site URL (for reset links, verification links etc)
  PUBLIC_SITE_URL: z.string().url('PUBLIC_SITE_URL must be a valid URL').default('http://localhost:3000'),

  // CORS origins are configured explicitly for each deployment environment.
  CORS_ORIGINS: z
    .string()
    .min(1, 'CORS_ORIGINS is required')
    .default('http://localhost:3000')
    .transform((val) => val.split(',').map((s) => s.trim()).filter(Boolean))
    .refine((origins) => origins.length > 0 && origins.every((origin) => {
      try {
        return origin !== '*' && new URL(origin).origin === origin;
      } catch {
        return false;
      }
    }), 'CORS_ORIGINS must contain explicit origins without paths or wildcards'),

  // AI
  OLLAMA_BASE_URL: z.string().url('OLLAMA_BASE_URL must be a valid URL').default('http://localhost:11434'),
  AI_SERVICE_URL: z.string().url('AI_SERVICE_URL must be a valid URL').default('http://localhost:8000'),
  OLLAMA_MODEL: z.string().default('llama3'),
  AI_PRODUCT_API_URL: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().url().optional(),
  ),
  AI_PRODUCT_API_KEY: z.string().optional(),
  AI_PRODUCT_MODEL: z.string().min(1).default('gpt-4o-mini'),
  AI_PROVIDER: z.enum(['openai-compatible']).default('openai-compatible'),
  AI_API_URL: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().url().optional(),
  ),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().trim().min(1).max(100).default('gpt-4o-mini'),
  AI_TIMEOUT_MS: z.coerce.number().int().min(250).max(30_000).default(10_000),

  // Feature flags are explicit deployment opt-ins; unfinished capabilities default off.
  FEATURE_AI_SEARCH: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FEATURE_STYLE_ASSISTANT: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FEATURE_COMPLETE_THE_LOOK: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FEATURE_RECOMMENDATIONS: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FEATURE_PERSONALIZED_RECOMMENDATIONS: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FEATURE_RECENTLY_VIEWED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FEATURE_AI_PRODUCT_FILL: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FEATURE_1688_PARSER: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FEATURE_PINDUODUO_PARSER: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FEATURE_IPOST: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FEATURE_N8N: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FEATURE_TELEGRAM_PRODUCT_PUBLISH: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FEATURE_AUTO_CURRENCY: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FEATURE_SMS_VERIFICATION: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  N8N_WEBHOOK_URL: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().url().optional(),
  ),
  N8N_WEBHOOK_SECRET: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().min(32).optional(),
  ),
  FEATURE_VISUAL_SEARCH: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FEATURE_SIMILAR_PRODUCTS: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FEATURE_IMAGE_EMBEDDINGS: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  VISUAL_SEARCH_MAX_IMAGE_MB: z.coerce.number().int().min(1).max(10).default(10),
  VISUAL_SEARCH_RATE_LIMIT_MAX: z.coerce.number().int().positive().max(20).default(5),
  VISUAL_SEARCH_RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().positive().max(3600).default(60),
  VISUAL_SEARCH_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(10_000),
  AI_REQUEST_RATE_LIMIT_MAX: z.coerce.number().int().positive().max(20).default(5),
  AI_REQUEST_RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().positive().max(3600).default(60),
  ACTIVE_IMAGE_EMBEDDING_VERSION: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/).default('v1'),
  SMS_API_URL: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().url().optional(),
  ),
  SMS_API_TOKEN: z.string().optional(),
  SMS_SENDER: z.string().optional(),
  TELEGRAM_ADMIN_BOT: z.string().optional(),
  TELEGRAM_MINI_APP_BOT_TOKEN: z.string().optional(),
  TELEGRAM_MINI_APP_URL: z.union([z.string().url(), z.literal('')]).optional().transform((value) => value || undefined),
  TELEGRAM_CHANNEL_ID: z.string().optional(),

  // Media storage
  STORAGE_DRIVER: z.enum(['local', 'cloudinary']).default('local'),
  STORAGE_PATH: z.string().default('/tmp/uploads'),
  MAX_FILE_SIZE: z.coerce.number().int().positive().default(10 * 1024 * 1024), // 10 MB

  // Cloudinary (используется при STORAGE_DRIVER=cloudinary)
  CLOUDINARY_CLOUD_NAME: z.string().min(1).optional(),
  CLOUDINARY_API_KEY: z.string().min(1).optional(),
  CLOUDINARY_API_SECRET: z.string().min(1).optional(),
  CLOUDINARY_FOLDER: z.string().default('averon/products'),

  // Email (Resend)
  RESEND_API_KEY: z.string().optional(),

  // Rate limiting
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
}).superRefine((values, context) => {
  for (const entry of values.TRUST_PROXY_ADDRESSES) {
    const slash = entry.indexOf('/');
    const address = slash === -1 ? entry : entry.slice(0, slash);
    const prefix = slash === -1 ? undefined : entry.slice(slash + 1);
    const family = isIP(address);
    const prefixValue = prefix === undefined ? undefined : Number(prefix);
    const maximumPrefix = family === 4 ? 32 : 128;
    const invalidPrefix = prefix !== undefined && (
      !/^\d+$/.test(prefix)
      || !Number.isInteger(prefixValue)
      || prefixValue === undefined
      || prefixValue < 1
      || prefixValue > maximumPrefix
    );
    if (
      family === 0
      || invalidPrefix
      || entry.indexOf('/', slash + 1) !== -1
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TRUST_PROXY_ADDRESSES'],
        message: 'TRUST_PROXY_ADDRESSES must contain IP addresses or valid CIDRs',
      });
    }
  }
  if (values.NODE_ENV !== 'production') return;
  if (new URL(values.PUBLIC_SITE_URL).protocol !== 'https:') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PUBLIC_SITE_URL'],
      message: 'PUBLIC_SITE_URL must use HTTPS in production',
    });
  }
  for (const [key, endpoint] of [
    ['AI_API_URL', values.AI_API_URL],
    ['AI_PRODUCT_API_URL', values.AI_PRODUCT_API_URL],
    ['SMS_API_URL', values.SMS_API_URL],
  ] as const) {
    if (endpoint && new URL(endpoint).protocol !== 'https:') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} must use HTTPS in production`,
      });
    }
  }
  if (values.N8N_WEBHOOK_URL) {
    const endpoint = new URL(values.N8N_WEBHOOK_URL);
    const railwayPrivateHttp = endpoint.protocol === 'http:' &&
      endpoint.hostname.endsWith('.railway.internal');
    if (endpoint.protocol !== 'https:' && !railwayPrivateHttp) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['N8N_WEBHOOK_URL'],
        message: 'N8N_WEBHOOK_URL must use HTTPS or Railway private networking in production',
      });
    }
    if (endpoint.username || endpoint.password) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['N8N_WEBHOOK_URL'],
        message: 'N8N_WEBHOOK_URL must not contain embedded credentials',
      });
    }
  }
  if (values.PARSER_IMPORT_TOKEN && !values.PUBLIC_SITE_URL.startsWith('https://')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PARSER_IMPORT_TOKEN'],
      message: 'Parser import API must be used over HTTPS in production',
    });
  }
});

function parseConfig() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `  • ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    console.error('❌ Invalid environment configuration:\n' + errors);
    process.exit(1);
  }

  const parsed = result.data;

  if (/^your_jwt_secret(?:_|$)/i.test(parsed.JWT_SECRET)) {
    throw new Error('FATAL: JWT_SECRET использует значение-заглушку из .env.example!');
  }

  if (isDeniedRefreshSecret(parsed.REFRESH_SECRET)) {
    throw new Error(
      'FATAL: REFRESH_SECRET использует скомпрометированное значение по умолчанию или плейсхолдер! Сгенерируйте уникальный ключ через `openssl rand -hex 32`.'
    );
  }

  // В production проверяем обязательность Cloudinary конфигурации
  if (parsed.NODE_ENV === 'production') {
    const hasCloudinaryKeys = Boolean(
      parsed.CLOUDINARY_CLOUD_NAME &&
      parsed.CLOUDINARY_API_KEY &&
      parsed.CLOUDINARY_API_SECRET
    );
    if (!hasCloudinaryKeys && parsed.STORAGE_DRIVER !== 'local') {
      console.error(
        '❌ В production обязательны CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.\n' +
        'Локальное файловое хранилище на Railway эфемерно — файлы будут теряться при рестарте контейнера.\n' +
        'Если это осознанное решение — явно укажи STORAGE_DRIVER=local.',
      );
      process.exit(1);
    }
  }

  return parsed;
}

export const config = parseConfig();
export type Config = typeof config;
