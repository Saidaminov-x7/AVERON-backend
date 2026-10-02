import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config';
import { featureFlags } from './feature-flags';
import { visualSimilarityService } from '../visual-search/runtime';
import { catalogAiService } from '../commerce/catalog-ai-service';
import { adminMiddleware } from '../../lib/adminMiddleware';

export const capabilitiesModule: FastifyPluginAsync = async (app) => {
  app.get('/capabilities', async () => {
    const capabilities = featureFlags.capabilities();
    return {
      ...capabilities,
      visualSearch: capabilities.visualSearch && visualSimilarityService.isAvailable(),
      similarProducts: capabilities.similarProducts && visualSimilarityService.isAvailable(),
      imageEmbeddings: capabilities.imageEmbeddings && visualSimilarityService.isAvailable(),
      aiProductFill: capabilities.aiProductFill && Boolean(config.AI_PRODUCT_API_URL && config.AI_PRODUCT_API_KEY),
      smsVerification: capabilities.smsVerification && Boolean(config.SMS_API_URL && config.SMS_API_TOKEN),
      telegramProductPublish: capabilities.telegramProductPublish && Boolean(
        config.TELEGRAM_MINI_APP_BOT_TOKEN && config.TELEGRAM_CHANNEL_ID,
      ),
      parserPinduoduo: false,
      ipost: false,
      n8n: false,
      autoCurrency: false,
    };
  });

  app.get('/admin/ai-status', { preHandler: adminMiddleware }, async () => ({
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

  app.get('/admin/recommendation-status', { preHandler: adminMiddleware }, async () => ({
    flags: {
      recommendations: featureFlags.isEnabled('RECOMMENDATIONS'),
      personalized: featureFlags.isEnabled('PERSONALIZED_RECOMMENDATIONS'),
      recentlyViewed: featureFlags.isEnabled('RECENTLY_VIEWED'),
    },
    embeddingAvailable: visualSimilarityService.isAvailable(),
    sharedCacheEnabled: false,
    personalizedResultsShared: false,
  }));
};
