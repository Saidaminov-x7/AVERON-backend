import type { FastifyPluginAsync } from 'fastify';
import { AdminRole } from '@prisma/client';
import { config } from '../../config';
import { featureFlags } from './feature-flags';
import { isVisualSearchAvailable } from '../visual-search/runtime';
import { catalogAiService } from '../commerce/catalog-ai-service';
import { requireAdminRole } from '../../lib/adminMiddleware';

const diagnosticsAdminHandler = [requireAdminRole(AdminRole.SUPER_ADMIN, AdminRole.ADMIN)];

export const capabilitiesModule: FastifyPluginAsync = async (app) => {
  app.get('/capabilities', async () => {
    const capabilities = featureFlags.capabilities();
    return {
      ...capabilities,
      local3dGeneration: false,
      parser1688: capabilities.parser1688 && Boolean(config.PARSER_IMPORT_TOKEN),
      visualSearch: capabilities.visualSearch && isVisualSearchAvailable(),
      similarProducts: capabilities.similarProducts && isVisualSearchAvailable(),
      imageEmbeddings: capabilities.imageEmbeddings && isVisualSearchAvailable(),
      aiProductFill: capabilities.aiProductFill && Boolean(config.AI_PRODUCT_API_URL && config.AI_PRODUCT_API_KEY),
      smsVerification: capabilities.smsVerification && Boolean(config.SMS_API_URL && config.SMS_API_TOKEN),
      telegramProductPublish: capabilities.telegramProductPublish && isTelegramProductPublisherConfigured(),
      telegramProductPublishFeatureEnabled: featureFlags.isEnabled('TELEGRAM_PRODUCT_PUBLISH'),
      telegramProductPublishConfigured: isTelegramProductPublisherConfigured(),
      parserPinduoduo: false,
      ipost: false,
      n8n: capabilities.n8n,
      autoCurrency: false,
    };
  });

  app.get('/admin/ai-status', { preHandler: diagnosticsAdminHandler }, async () => ({
    flags: {
      aiSearch: featureFlags.isEnabled('AI_SEARCH'),
      styleAssistant: featureFlags.isEnabled('STYLE_ASSISTANT'),
      completeTheLook: featureFlags.isEnabled('COMPLETE_THE_LOOK'),
    },
    provider: config.AI_PROVIDER,
    model: catalogAiService.safeModel(),
    providerConfigured: catalogAiService.isConfigured(),
    timeoutMs: config.AI_TIMEOUT_MS,
  }));

  app.get('/admin/recommendation-status', { preHandler: diagnosticsAdminHandler }, async () => ({
    flags: {
      recommendations: featureFlags.isEnabled('RECOMMENDATIONS'),
      personalized: featureFlags.isEnabled('PERSONALIZED_RECOMMENDATIONS'),
      recentlyViewed: featureFlags.isEnabled('RECENTLY_VIEWED'),
    },
    embeddingAvailable: isVisualSearchAvailable(),
    sharedCacheEnabled: false,
    personalizedResultsShared: false,
  }));

  app.get('/admin/integration-diagnostics', { preHandler: diagnosticsAdminHandler }, async () => {
    let redisHealthy = false;
    try {
      redisHealthy = await app.redis.ping() === 'PONG';
    } catch {
      redisHealthy = false;
    }
    const capability = (
      name: string,
      featureEnabled: boolean,
      configured: boolean,
      implementationStatus: string,
      verificationStatus: string,
      degraded = false,
    ) => ({
      name,
      featureEnabled,
      configured,
      implementationStatus,
      verificationStatus,
      degraded,
      lastSuccessfulOperation: null,
    });
    const diagnostics = [
      capability('1688', featureFlags.isEnabled('PARSER_1688'), Boolean(config.PARSER_IMPORT_TOKEN), 'IMPLEMENTED', 'NOT_LIVE_VERIFIED'),
      capability('Pinduoduo', false, false, 'BLOCKED_BY_PROVIDER', 'NOT_LIVE_VERIFIED'),
      capability('AI Product Fill', featureFlags.isEnabled('AI_PRODUCT_FILL'), Boolean(config.AI_PRODUCT_API_URL && config.AI_PRODUCT_API_KEY), 'IMPLEMENTED', 'NOT_LIVE_VERIFIED'),
      capability('iPost', false, false, 'BLOCKED_BY_PROVIDER', 'NOT_CONFIGURED'),
      capability('n8n', featureFlags.isEnabled('N8N'), Boolean(config.N8N_WEBHOOK_URL && config.N8N_WEBHOOK_SECRET), 'IMPLEMENTED', 'TESTED_WITH_MOCK'),
      capability('Telegram', featureFlags.isEnabled('TELEGRAM_PRODUCT_PUBLISH'), isTelegramProductPublisherConfigured(), 'IMPLEMENTED', 'NOT_LIVE_VERIFIED'),
      capability('Currency', false, false, 'NOT_CONFIGURED', 'NOT_LIVE_VERIFIED'),
      capability('SMS', featureFlags.isEnabled('SMS_VERIFICATION'), Boolean(config.SMS_API_URL && config.SMS_API_TOKEN), 'IMPLEMENTED', 'TESTED_WITH_MOCK'),
      capability('Redis', true, Boolean(config.REDIS_URL), 'IMPLEMENTED', redisHealthy ? 'LIVE_VERIFIED' : 'NOT_LIVE_VERIFIED', !redisHealthy),
    ];
    return diagnostics.map((item) => item.name === 'Currency'
      ? {
        ...item,
        rateProvider: null,
        currentRate: null,
        rateFetchedAt: null,
        providerTimestamp: null,
        stale: null,
      }
      : item);
  });
};
