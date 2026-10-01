import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createFeatureFlags } from '../feature-flags';
import { capabilitiesModule } from '..';

describe('feature flags', () => {
  it('keeps unfinished integrations disabled when configured with their defaults', () => {
    const flags = createFeatureFlags({
      AI_PRODUCT_FILL: false,
      PARSER_1688: false,
      PARSER_PINDUODUO: false,
      IPOST: false,
      N8N: false,
      TELEGRAM_PRODUCT_PUBLISH: false,
      AUTO_CURRENCY: false,
      SMS_VERIFICATION: false,
    });

    expect(flags.capabilities()).toEqual({
      aiProductFill: false,
      parser1688: false,
      parserPinduoduo: false,
      ipost: false,
      n8n: false,
      telegramProductPublish: false,
      autoCurrency: false,
      smsVerification: false,
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
      'autoCurrency',
      'ipost',
      'n8n',
      'parser1688',
      'parserPinduoduo',
      'smsVerification',
      'telegramProductPublish',
    ]);
    expect(Object.values(response.json()).every((value) => typeof value === 'boolean')).toBe(true);
    await app.close();
  });
});
