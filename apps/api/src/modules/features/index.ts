import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config';
import { featureFlags } from './feature-flags';
import { visualSimilarityService } from '../visual-search/runtime';

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
        config.TELEGRAM_ADMIN_BOT && config.TELEGRAM_CHANNEL_ID,
      ),
      parserPinduoduo: false,
      ipost: false,
      n8n: false,
      autoCurrency: false,
    };
  });
};
