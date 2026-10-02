import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createFeatureFlags } from '../feature-flags';
import { capabilitiesModule } from '..';

describe('feature flags', () => {
  it('keeps unfinished integrations disabled when configured with their defaults', () => {
    const flags = createFeatureFlags({
      AI_SEARCH: false,
      STYLE_ASSISTANT: false,
      COMPLETE_THE_LOOK: false,
      RECOMMENDATIONS: false,
      PERSONALIZED_RECOMMENDATIONS: false,
      RECENTLY_VIEWED: false,
      AI_PRODUCT_FILL: false,
      PARSER_1688: false,
      PARSER_PINDUODUO: false,
      IPOST: false,
      N8N: false,
      TELEGRAM_PRODUCT_PUBLISH: false,
      AUTO_CURRENCY: false,
      SMS_VERIFICATION: false,
      VISUAL_SEARCH: false,
      SIMILAR_PRODUCTS: false,
      IMAGE_EMBEDDINGS: false,
    });

    expect(flags.capabilities()).toEqual({
      aiSearch: false,
      styleAssistant: false,
      completeTheLook: false,
      recommendations: false,
      personalizedRecommendations: false,
      recentlyViewed: false,
      aiProductFill: false,
      parser1688: false,
      parserPinduoduo: false,
      ipost: false,
      n8n: false,
      telegramProductPublish: false,
      autoCurrency: false,
      smsVerification: false,
      visualSearch: false,
      similarProducts: false,
      imageEmbeddings: false,
    });
    expect(flags.isEnabled('AI_PRODUCT_FILL')).toBe(false);
  });

  it('returns only the public capability booleans', async () => {
    const app = Fastify();
    await app.register(capabilitiesModule, { prefix: '/api/v1' });
    const response = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json()).sort()).toEqual([
      'aiProductFill',
      'aiSearch',
      'autoCurrency',
      'completeTheLook',
      'imageEmbeddings',
      'ipost',
      'n8n',
      'parser1688',
      'parserPinduoduo',
      'personalizedRecommendations',
      'recentlyViewed',
      'recommendations',
      'similarProducts',
      'smsVerification',
      'styleAssistant',
      'telegramProductPublish',
      'visualSearch',
    ]);
    expect(Object.values(response.json()).every((value) => typeof value === 'boolean')).toBe(true);
    await app.close();
  });
});
