// apps/api/src/config/env.ts

import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

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

  // CORS — список доменов через запятую, например: https://ijarauz.uz,https://www.ijarauz.uz
  CORS_ORIGINS: z
    .string()
    .min(1, 'CORS_ORIGINS is required')
    .default('http://localhost:3000')
    .transform((val) => val.split(',').map((s) => s.trim()).filter(Boolean)),

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

  // Feature flags are explicit deployment opt-ins; unfinished capabilities default off.
  FEATURE_AI_PRODUCT_FILL: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FEATURE_1688_PARSER: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FEATURE_PINDUODUO_PARSER: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FEATURE_IPOST: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FEATURE_N8N: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FEATURE_TELEGRAM_PRODUCT_PUBLISH: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FEATURE_AUTO_CURRENCY: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FEATURE_SMS_VERIFICATION: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  SMS_API_URL: z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().url().optional(),
  ),
  SMS_API_TOKEN: z.string().optional(),
  SMS_SENDER: z.string().optional(),
  TELEGRAM_ADMIN_BOT: z.string().optional(),
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
  if (values.NODE_ENV !== 'production') return;
  if (new URL(values.PUBLIC_SITE_URL).protocol !== 'https:') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PUBLIC_SITE_URL'],
      message: 'PUBLIC_SITE_URL must use HTTPS in production',
    });
  }
  for (const [key, endpoint] of [
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

  if (
    parsed.JWT_SECRET === 'your_jwt_secret' ||
    parsed.JWT_SECRET === 'your_jwt_secret_min_32_characters_long_super_secure'
  ) {
    throw new Error('FATAL: JWT_SECRET использует значение-заглушку из .env.example!');
  }

  if (
    parsed.REFRESH_SECRET === 'your_refresh_secret' ||
    parsed.REFRESH_SECRET === 'your_refresh_secret_min_32_characters_long_super_secure' ||
    parsed.REFRESH_SECRET === 'e7a2b9c4f1d8e3a5c7f2b6a9d1e4f8c2b5e7a1d3f9c4b8e2a6d1f5c7b3e9a4f2'
  ) {
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
