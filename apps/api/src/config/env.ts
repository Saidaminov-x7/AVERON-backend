// apps/api/src/config/env.ts

import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Database
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid PostgreSQL URL'),

  // Redis
  REDIS_URL: z.string().url('REDIS_URL must be a valid Redis URL'),

  // JWT
  JWT_SECRET: z.string().min(32, 'JWT_SECRET должен быть минимум 32 символа'),
  REFRESH_SECRET: z.string().min(32, 'REFRESH_SECRET must be at least 32 characters'),
  GOOGLE_CLIENT_ID: z.string().optional(),

  // Telegram 2FA & Notification Bot
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ADMIN_CHAT_ID: z.string().optional(),

  // Public Site URL (for reset links, verification links etc)
  PUBLIC_SITE_URL: z.string().url('PUBLIC_SITE_URL must be a valid URL').default('https://ijarauz.uz'),

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

  // Media storage
  STORAGE_DRIVER: z.enum(['local', 'cloudinary']).default('local'),
  STORAGE_PATH: z.string().default('/tmp/uploads'),
  MAX_FILE_SIZE: z.coerce.number().int().positive().default(10 * 1024 * 1024), // 10 MB

  // Cloudinary (используется при STORAGE_DRIVER=cloudinary)
  CLOUDINARY_CLOUD_NAME: z.string().min(1).optional(),
  CLOUDINARY_API_KEY: z.string().min(1).optional(),
  CLOUDINARY_API_SECRET: z.string().min(1).optional(),
  CLOUDINARY_FOLDER: z.string().default('ijarauz/listings'),

  // Email (Resend)
  RESEND_API_KEY: z.string().optional(),

  // Rate limiting
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
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
