// apps/api/src/modules/site-settings/index.ts
// Публичный эндпоинт настроек сайта — без авторизации, кэшируется в Redis

import { FastifyPluginAsync } from 'fastify';

const CACHE_KEY = 'site:settings:public';
const CACHE_TTL = 30; // 30 секунд — короткий TTL для быстрого отклика на изменения

export const siteSettingsPublicModule: FastifyPluginAsync = async (server) => {
  /**
   * GET /site-settings/public — публичный эндпоинт без авторизации
   * Используется основным фронтендом для проверки maintenance mode.
   * Кэшируется в Redis с TTL 30 секунд.
   */
  server.get('/public', async (_request, reply) => {
    // 1. Пробуем взять из Redis
    const cached = await server.redis.get(CACHE_KEY);
    if (cached) {
      reply.header('X-Cache', 'HIT');
      return JSON.parse(cached);
    }

    // 2. Берём из БД
    let settings = await server.prisma.siteSettings.findUnique({
      where: { id: 'singleton' },
      select: {
        maintenanceMode: true,
        maintenanceMessage: true,
        maintenancePasswordEnabled: true,
        siteName: true,
        contactEmail: true,
        contactPhone: true,
        googleAuthEnabled: true,
        autoModerationEnabled: true,
        maxImagesPerListing: true,
        logoUrl: true,
        navLinks: true,
        yandexMetrikaId: true,
        yandexMetrikaEnabled: true,
        mobilePinchZoomEnabled: true,
      },
    });

    // Если записи нет — дефолтные значения
    if (!settings) {
      settings = {
        maintenanceMode: false,
        maintenanceMessage: null,
        maintenancePasswordEnabled: false,
        siteName: 'AVERON',
        contactEmail: process.env.ADMIN_EMAIL?.trim().toLowerCase() || '',
        contactPhone: '',
        googleAuthEnabled: true,
        autoModerationEnabled: false,
        maxImagesPerListing: 10,
        logoUrl: null,
        navLinks: null,
        yandexMetrikaId: '112059980',
        yandexMetrikaEnabled: true,
        mobilePinchZoomEnabled: true,
      };
    }

    const legacyName = settings.siteName.toLowerCase().includes('ijara');
    const normalizedEmail = settings.contactEmail.trim().toLowerCase();
    const demoEmails = new Set(['admin@gmail.com', 'test@example.com', 'admin@example.com']);
    const legacyEmail = normalizedEmail.includes('ijarauz') || demoEmails.has(normalizedEmail);
    const normalizedPhone = settings.contactPhone.replace(/\D/g, '');
    const legacyPhone = ['998712000000', '998900000000'].includes(normalizedPhone);
    settings = {
      ...settings,
      siteName: legacyName ? 'AVERON' : settings.siteName,
      contactEmail: legacyEmail ? '' : settings.contactEmail,
      contactPhone: legacyPhone ? '' : settings.contactPhone,
      navLinks: Array.isArray(settings.navLinks)
        ? settings.navLinks.filter((link: any) => !['/add-listing', '/chat'].includes(String(link?.href || link?.url || '')))
        : settings.navLinks,
    };

    // 3. Кэшируем в Redis
    await server.redis.set(CACHE_KEY, JSON.stringify(settings), 'EX', CACHE_TTL);

    reply.header('X-Cache', 'MISS');
    return settings;
  });

  /**
   * POST /site-settings/public/check-bypass — проверить пароль обхода тех. обслуживания
   * Возвращает { allowed: true } если пароль верный.
   */
  server.post<{ Body: { password: string } }>('/public/check-bypass', async (request, reply) => {
    const { password } = request.body || {};
    if (!password) {
      return reply.status(400).send({ message: 'Password is required' });
    }

    const settings = await server.prisma.siteSettings.findUnique({
      where: { id: 'singleton' },
      select: { maintenanceBypassPassword: true },
    });

    const bypassPassword = settings?.maintenanceBypassPassword;
    if (!bypassPassword) {
      return reply.status(404).send({ message: 'No bypass password configured' });
    }

    if (password === bypassPassword) {
      return { allowed: true };
    }

    return reply.status(401).send({ allowed: false, message: 'Неверный пароль' });
  });

  /**
   * GET /site-settings/public/theme — публичный эндпоинт дизайн-токенов
   * Используется Next.js фронтендом для генерации CSS-переменных :root.
   */
  server.get('/public/theme', async (_request, reply) => {
    const THEME_CACHE_KEY = 'site:theme:public';
    const THEME_CACHE_TTL = 60; // 1 минута

    // 1. Redis кэш
    const cached = await server.redis.get(THEME_CACHE_KEY);
    if (cached) {
      reply.header('X-Cache', 'HIT');
      return JSON.parse(cached);
    }

    // 2. БД
    const theme = await server.prisma.themeSettings.findUnique({
      where: { id: 'singleton' },
    });

    const tokens = {
      primaryColor: theme?.primaryColor ?? '#2563eb',
      secondaryColor: theme?.secondaryColor ?? '#0f766e',
      backgroundColor: theme?.backgroundColor ?? '#f9fafb',
      textColor: theme?.textColor ?? '#111827',
      borderRadius: theme?.borderRadius ?? '0.75rem',
      fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif',
    };

    // 3. Кэшируем
    await server.redis.set(THEME_CACHE_KEY, JSON.stringify(tokens), 'EX', THEME_CACHE_TTL);

    reply.header('X-Cache', 'MISS');
    return tokens;
  });
};
