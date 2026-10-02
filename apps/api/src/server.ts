// apps/api/src/server.ts

import 'dotenv/config';
import fastify from 'fastify';
import { fastifyHelmet } from '@fastify/helmet';
import { fastifyCors } from '@fastify/cors';
import { fastifyRateLimit } from '@fastify/rate-limit';
import fastifyCompress from '@fastify/compress';
import { fastifySwagger } from '@fastify/swagger';
import { fastifySwaggerUi } from '@fastify/swagger-ui';
import { fastifyJwt } from '@fastify/jwt';
import { fastifyCookie } from '@fastify/cookie';
import { fastifyStatic } from '@fastify/static';
import { fastifyMultipart } from '@fastify/multipart';
import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import argon2 from 'argon2';
import { ZodError } from 'zod';

import { mkdirSync } from 'fs';
import { config } from './config';
import { authModule } from './modules/auth';
import { mediaModule } from './modules/media';
import { adminModule } from './modules/admin';
import { staffModule } from './modules/admin/staff';
import { notificationsModule } from './modules/admin/notifications';
import { profileModule } from './modules/admin/profile';
import { themeModule } from './modules/admin/theme';
import { siteSettingsPublicModule } from './modules/site-settings';
import { errorReportsModule } from './modules/error-reports';
import { commerceModule } from './modules/commerce';
import { aiChatModule } from './modules/ai-chat';
import { analyticsModule } from './modules/analytics';
import { capabilitiesModule } from './modules/features';
import { productAiModule } from './modules/commerce/product-ai';
import { visualSearchModule } from './modules/visual-search';
import { createAdaptiveRateLimitCache } from './lib/adaptive-rate-limit-cache';
import { trustProxyOption } from './lib/trust-proxy';
import { registerN8nEventPublisher } from './modules/integrations/n8n-publisher';

// ─── Инициализация клиентов ───────────────────────────────────────────────────

const prisma = new PrismaClient({
  log:
    config.NODE_ENV === 'development'
      ? [{ emit: 'event', level: 'query' }, { emit: 'stdout', level: 'error' }, { emit: 'stdout', level: 'warn' }]
      : [{ emit: 'event', level: 'query' }, { emit: 'stdout', level: 'error' }],
});

// C6: Предупреждение о медленных Prisma-запросах (> 500мс)
prisma.$on('query', (e) => {
  if (e.duration > 500) {
    server.log.warn({ durationMs: e.duration }, 'Slow Prisma query');
  }
});

const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});

// Убедимся, что директория для хранения файлов существует
mkdirSync(config.STORAGE_PATH, { recursive: true });

// ─── Создание сервера ─────────────────────────────────────────────────────────

const server = fastify({
  logger: {
    level: config.LOG_LEVEL,
    ...(config.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  },
  trustProxy: trustProxyOption(config.TRUST_PROXY_ADDRESSES),
  ajv: {
    customOptions: {
      strict: 'log',
      keywords: ['kind', 'modifier'],
    },
  },
});

if (config.NODE_ENV === 'production' && config.TRUST_PROXY_ADDRESSES.length === 0) {
  server.log.warn(
    'TRUST_PROXY_ADDRESSES is empty; forwarded client IP headers are ignored and rate limits use the direct peer address',
  );
}

const isAdaptiveRateLimitEnabled = createAdaptiveRateLimitCache(
  async () => {
    const settings = await prisma.siteSettings.findUnique({
      where: { id: 'singleton' },
      select: { adaptiveRateLimitEnabled: true },
    });
    return settings?.adaptiveRateLimitEnabled === true;
  },
  (error) => server.log.warn({ err: error }, '[Rate Limit] Failed to load adaptive settings; using the configured global limit'),
);

redis.on('error', (err) => {
  server.log.error({ err }, '[Redis] Connection error');
});

// ─── Плагины безопасности ─────────────────────────────────────────────────────

// C4: Gzip/Brotli сжатие ответов (регистрировать до роутов)
server.register(fastifyCompress, { global: true, encodings: ['br', 'gzip', 'deflate'] });

server.register(fastifyHelmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'res.cloudinary.com', 'data:'],
      connectSrc: ["'self'", ...config.CORS_ORIGINS],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
});

const allowedOrigins = new Set(config.CORS_ORIGINS);

server.register(fastifyCors, {
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origin is not allowed by CORS'), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});

server.register(fastifyRateLimit, {
  redis,
  global: true,
  max: async (req) => {
    if (await isAdaptiveRateLimitEnabled()) {
      const routePath = req.url.split('?', 1)[0];
      const adaptiveLimitPaths = [
        '/api/v1/products',
        '/api/v1/products/visual-search',
        '/ai-chat/chat',
        '/ai-chat/stream',
      ];
      if (adaptiveLimitPaths.some((route) =>
        routePath === route || routePath.startsWith(`${route}/`),
      )) {
        return 40;
      }
    }
    return config.RATE_LIMIT_MAX;
  },
  timeWindow: config.RATE_LIMIT_WINDOW,
  skipOnError: false,
  errorResponseBuilder: (_req, context) => ({
    statusCode: 429,
    error: 'Too Many Requests',
    message: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)}s`,
  }),
});

server.register(fastifyJwt, {
  secret: config.JWT_SECRET,
  cookie: {
    cookieName: 'accessToken',
    signed: false,
  },
  sign: {
    expiresIn: '60m',
  },
});

server.register(fastifyCookie);

server.register(fastifyMultipart, {
  limits: { fileSize: config.MAX_FILE_SIZE },
});

// ─── Статические файлы (загружаемые медиа) ───────────────────────────────────

server.register(fastifyStatic, {
  root: config.STORAGE_PATH,
  prefix: '/uploads/',
  decorateReply: false,
});

// ─── Swagger документация ─────────────────────────────────────────────────────

if (config.NODE_ENV !== 'production') {
  server.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'AVERON Commerce API',
        description: 'API магазина товаров из Китая с доставкой по Узбекистану',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });
  server.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });
}

import { registerErrorHandler } from './lib/errorHandler';
import { v2 as cloudinary } from 'cloudinary';

// ─── Декораторы DI ────────────────────────────────────────────────────────────

server.decorate('prisma', prisma);
server.decorate('redis', redis);
registerN8nEventPublisher(redis, server.log);

// ─── Единый обработчик ошибок ────────────────────────────────────────────────
registerErrorHandler(server);

// ─── Маршруты модулей ─────────────────────────────────────────────────────────

server.register(authModule, { prefix: '/auth' });
server.register(mediaModule, { prefix: '/media' });

// ─── Административный модуль (требует роль ADMIN/AdminRole) ───────────────────
server.register(adminModule, { prefix: '/admin' });
server.register(staffModule, { prefix: '/admin/staff' });
server.register(profileModule, { prefix: '/admin' });
server.register(themeModule, { prefix: '/admin' });
server.register(notificationsModule, { prefix: '/admin/notifications' });
server.register(commerceModule, { prefix: '/api/v1' });
server.register(visualSearchModule, { prefix: '/api/v1' });
server.register(capabilitiesModule, { prefix: '/api/v1' });
server.register(productAiModule, { prefix: '/api/v1' });
server.register(aiChatModule, { prefix: '/ai-chat' });
server.register(analyticsModule, { prefix: '/analytics' });

// ─── Публичные эндпоинты (без авторизации) ───────────────────────────────────
server.register(siteSettingsPublicModule, { prefix: '/site-settings' });
server.register(errorReportsModule, { prefix: '/error-reports' });

// ─── Health-check эндпоинты ───────────────────────────────────────────────────

server.get('/', async (_request, reply) => reply.send({
  name: 'AVERON API',
  status: 'ok',
  health: '/health',
  version: process.env.npm_package_version || '1.0.0',
}));

// B2: Health с реальной проверкой DB + Redis
server.get('/health', {
  schema: { tags: ['Health'] },
}, async (_req, reply) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    await redis.ping();
    return reply.send({ status: 'ok', db: 'up', redis: 'up', timestamp: new Date().toISOString() });
  } catch (err) {
    server.log.error({ err }, 'Health check failed');
    return reply.status(503).send({ status: 'degraded', db: 'unknown', redis: 'unknown' });
  }
});

server.get('/health/live', {
  schema: { tags: ['Health'] },
}, async () => ({ status: 'live', timestamp: new Date().toISOString() }));

server.get('/health/ai', {
  schema: { tags: ['Health'] },
}, async (request, reply) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${config.OLLAMA_BASE_URL}/api/tags`, {
      method: 'GET',
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (res.ok) {
      await res.body?.cancel();
      return reply.send({
        status: 'up',
        service: 'ollama',
        timestamp: new Date().toISOString(),
      });
    }
    await res.body?.cancel();
    return reply.status(503).send({
      status: 'down',
      service: 'ollama',
      statusCode: res.status,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    request.log.warn({
      requestId: request.id,
      errorType: error instanceof Error ? error.name : 'unknown',
    }, 'AI health check failed');
    return reply.status(503).send({
      status: 'down',
      service: 'ollama',
      error: 'AI_SERVICE_UNAVAILABLE',
      timestamp: new Date().toISOString(),
    });
  }
});

server.get('/health/ready', {
  schema: { tags: ['Health'] },
}, async (_req, reply) => {
  const checks: Record<string, boolean> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = true;
  } catch {
    checks.database = false;
  }

  try {
    const pong = await redis.ping();
    checks.redis = pong === 'PONG';
  } catch {
    checks.redis = false;
  }

  if (config.CLOUDINARY_CLOUD_NAME && config.CLOUDINARY_API_KEY && config.CLOUDINARY_API_SECRET) {
    try {
      cloudinary.config({
        cloud_name: config.CLOUDINARY_CLOUD_NAME,
        api_key: config.CLOUDINARY_API_KEY,
        api_secret: config.CLOUDINARY_API_SECRET,
      });
      await cloudinary.api.ping();
      checks.cloudinary = true;
    } catch {
      checks.cloudinary = false;
    }
  }

  // AI Health Check
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const aiRes = await fetch(`${config.OLLAMA_BASE_URL}/api/tags`, {
      method: 'GET',
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    checks.aiService = aiRes.ok;
  } catch {
    checks.aiService = false;
  }

  const allHealthy = Object.values(checks).every(Boolean);
  return reply.status(allHealthy ? 200 : 503).send({
    status: allHealthy ? 'ready' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  });
});

// B1: Запись в AuditLog при 401/403 (security events)
server.addHook('onResponse', async (request, reply) => {
  const routineAuthProbe = request.url.startsWith('/auth/refresh') || request.url.startsWith('/auth/me') || request.url.startsWith('/admin/theme');
  if ((reply.statusCode === 401 || reply.statusCode === 403) && !routineAuthProbe) {
    prisma.auditLog.create({
      data: {
        userId: (request as any).user?.userId ?? null,
        action: 'SECURITY_DENIED',
        resource: request.url,
        meta: {
          path: request.url,
          method: request.method,
          statusCode: reply.statusCode,
          ip: request.ip,
        },
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        timestamp: new Date(),
      },
    }).catch((err) => server.log.error({ err }, 'Failed to write security audit log'));
  }
});

// ─── Глобальный обработчик ошибок ────────────────────────────────────────────

server.setErrorHandler((error, request, reply) => {
  const isProduction = config.NODE_ENV === 'production';
  const errorProperties: Record<string, unknown> = typeof error === 'object' && error !== null
    ? error as Record<string, unknown>
    : {};
  const errorType = error instanceof Error ? error.name : 'UnknownError';
  const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
  const errorCode = typeof errorProperties.code === 'string' ? errorProperties.code : undefined;
  const diagnosticStage = typeof errorProperties.diagnosticStage === 'string'
    ? errorProperties.diagnosticStage
    : 'request_handler';
  const statusCode = typeof errorProperties.statusCode === 'number' ? errorProperties.statusCode : 500;

  // Keep request diagnostics useful without recording query strings or error payloads.
  request.log.error({
    requestId: request.id,
    diagnosticStage,
    errorType,
    errorCode,
    method: request.method,
    route: request.routeOptions.url,
    userId: request.user?.userId,
  }, 'Request error');

  if (error instanceof ZodError) {
    return reply.status(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Validation failed',
      details: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  // Fastify validation errors (400)
  if (Array.isArray(errorProperties.validation)) {
    return reply.status(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Validation failed',
      details: isProduction ? undefined : errorProperties.validation,
    });
  }

  // Rate limit (429)
  if (statusCode === 429) {
    return reply.status(429).send({
      statusCode: 429,
      error: 'Too Many Requests',
      message: errorMessage,
    });
  }

  // Известные ошибки приложения
  return reply.status(statusCode).send({
    statusCode,
    error: statusCode === 500 ? 'Internal Server Error' : errorType,
    // В проде не отдаём детали 500-ых ошибок наружу
    message: statusCode === 500 && isProduction ? 'An unexpected error occurred' : errorMessage,
  });
});

// ─── Not Found handler ────────────────────────────────────────────────────────

server.setNotFoundHandler((request, reply) => {
  reply.status(404).send({
    statusCode: 404,
    error: 'Not Found',
    message: `Route ${request.method} ${request.url} not found`,
  });
});

import { startTelegramBot, stopTelegramBot } from './lib/telegram';
import { runScheduledBackup } from './lib/jobs/scheduled-backup';
import { retryPendingWebhookDeliveries } from './lib/webhookDelivery';

// ─── Запуск и Graceful Shutdown ───────────────────────────────────────────────

let scheduledBackupInterval: NodeJS.Timeout | null = null;
let webhookRetryInterval: NodeJS.Timeout | null = null;

const start = async () => {
  try {
    const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const adminPassword = (process.env.ADMIN_PASSWORD || process.env.SEED_ADMIN_PASSWORD)?.trim();
    if (adminEmail && adminPassword) {
      const passwordHash = await argon2.hash(adminPassword);
      await prisma.user.upsert({
        where: { email: adminEmail },
        update: { passwordHash, role: 'ADMIN', adminRole: 'SUPER_ADMIN', isBlocked: false },
        create: {
          email: adminEmail,
          phone: process.env.ADMIN_PHONE?.trim() || '+998900000001',
          passwordHash,
          name: process.env.ADMIN_NAME?.trim() || 'Администратор AVERON',
          role: 'ADMIN',
          adminRole: 'SUPER_ADMIN',
          verified: true,
        },
      });
      server.log.info({ email: adminEmail }, 'Super admin account synchronized from environment');
    } else {
      server.log.warn('ADMIN_EMAIL and ADMIN_PASSWORD are not set; admin bootstrap skipped');
    }

    await server.listen({ port: config.PORT, host: '0.0.0.0' });
    server.log.info(`✅ Server listening on port ${config.PORT} (${config.NODE_ENV})`);

    // Запускаем Telegram-бота для 2FA
    startTelegramBot(redis, server.log);

    // Первичная очистка истёкших промо-акций сразу при старте
    // Первичная запись снапшота целостности базы данных
    runScheduledBackup(prisma, server.log).catch((err) => {
      server.log.error({ err }, '[Backup] Error during startup runScheduledBackup check');
    });

    // Периодическая проверка целостности и снапшот данных (каждые 24 часа)
    scheduledBackupInterval = setInterval(() => {
      runScheduledBackup(prisma, server.log).catch((err) => {
        server.log.error({ err }, '[Backup] Error in runScheduledBackup interval');
      });
    }, 24 * 60 * 60 * 1000);

    // Периодический воркер повторной доставки вебхуков (каждые 60 секунд)
    webhookRetryInterval = setInterval(() => {
      retryPendingWebhookDeliveries(prisma, server.log).catch((err) => {
        server.log.error({ err }, '[Webhook] Error in retryPendingWebhookDeliveries');
      });
    }, 60 * 1000);

    // Предупреждение о включённых флагах Категории 2 (без полной бэкенд-интеграции)
    try {
      const siteSettings = await prisma.siteSettings.findUnique({ where: { id: 'singleton' } });
      const unimplementedFlags = [
        'paymeClickEnabled',
        'autoFiscalizationEnabled',
        'smsGatewayEnabled',
        'oneIdAuthEnabled',
        'yandexRealtyXmlEnabled',
        'geoIpValidationEnabled',
        'fieldEncryptionEnabled',
        'sessionQuarantineEnabled',
        'deviceIpBanEnabled',
        'tokenRotationEnabled',
        'thunderingHerdEnabled',
        'watermarkDetectorEnabled',
        'openTelemetryEnabled',
      ];
      const enabledUnimplemented = unimplementedFlags.filter(
        (flag) => (siteSettings as any)?.[flag] === true,
      );
      if (enabledUnimplemented.length > 0) {
        server.log.warn(
          { flags: enabledUnimplemented },
          '[Config] Включены флаги без реальной backend-логики — они помечены как «В разработке» и не влияют на поведение системы',
        );
      }
    } catch {}
  } catch (err) {
    server.log.error(err, 'Failed to start server');
    process.exit(1);
  }
};

const shutdown = async (signal: string) => {
  server.log.info(`Received ${signal}, graceful shutdown...`);
  try {
    if (scheduledBackupInterval) {
      clearInterval(scheduledBackupInterval);
    }
    if (webhookRetryInterval) {
      clearInterval(webhookRetryInterval);
    }
    stopTelegramBot();
    await server.close();
    await prisma.$disconnect();
    redis.disconnect();
    server.log.info('Server closed gracefully');
    process.exit(0);
  } catch (err) {
    server.log.error(err, 'Error during shutdown');
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
