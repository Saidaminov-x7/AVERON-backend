import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramPublishError } from '../telegram-publisher';

const mocks = vi.hoisted(() => ({
  featureEnabled: false,
  sendTelegramCard: vi.fn(async () => 'telegram-message-1'),
}));

vi.mock('../../../lib/adminMiddleware', () => ({
  adminMiddleware: async (request: { headers: Record<string, string | string[] | undefined> }, reply: { status: (code: number) => { send: (data: unknown) => unknown } }) => {
    if (request.headers['x-test-role'] !== 'admin') {
      return reply.status(request.headers['x-test-role'] ? 403 : 401).send({ code: 'FORBIDDEN' });
    }
    Object.assign(request, {
      user: { userId: '00000000-0000-4000-8000-000000000001', role: 'ADMIN', adminRole: 'SUPER_ADMIN' },
    });
  },
}));
vi.mock('../../../config', () => ({
  config: {
    TELEGRAM_CHANNEL_ID: '@averon_test',
    TELEGRAM_MINI_APP_BOT_TOKEN: 'test-token-not-for-real-transport',
    TELEGRAM_MINI_APP_URL: undefined,
    PUBLIC_SITE_URL: 'https://shop.example',
  },
}));
vi.mock('../../features/feature-flags', () => ({
  featureFlags: { isEnabled: () => mocks.featureEnabled },
}));
vi.mock('../telegram-publisher', () => ({
  TelegramPublishError: class TelegramPublishError extends Error {
    constructor(readonly code: string) { super(code); }
  },
  buildTelegramCard: vi.fn(() => ({
    title: 'Jacket',
    description: 'Description',
    priceUzs: '100,000',
    availability: 'IN_STOCK',
    estimatedAvailableAt: null,
    imageUrl: null,
    productUrl: 'https://shop.example/en/mini-app?product=jacket',
    captionText: 'Jacket',
    buttonText: 'Open product',
  })),
  sendTelegramCard: mocks.sendTelegramCard,
}));

import { telegramPublicationModule } from '../telegram-publication';

const PRODUCT_ID = '00000000-0000-4000-8000-000000000004';
const PUBLICATION_ID = '00000000-0000-4000-8000-000000000010';
const product = {
  id: PRODUCT_ID,
  slug: 'jacket',
  status: 'PUBLISHED',
  translations: { en: { title: 'Jacket' } },
  description: {},
  salePriceUzs: '100000',
  stock: 5,
  preorderEnabled: false,
  preorderLimit: 0,
  preorderReserved: 0,
  preorderEstimatedAt: null,
  images: [],
  variants: [],
};

function createApp({
  productStatus = 'PUBLISHED',
  updateCount = 1,
  publicationStatus = 'NOT_PUBLISHED',
}: {
  productStatus?: string;
  updateCount?: number;
  publicationStatus?: string;
} = {}) {
  const publication = {
    id: PUBLICATION_ID,
    status: publicationStatus,
    telegramMessageId: null as string | null,
    publishedAt: null as Date | null,
    lastAttemptAt: null as Date | null,
    errorCode: null as string | null,
    attemptCount: 0,
    captionOverride: null as string | null,
  };
  const prisma = {
    commerceProduct: {
      findUnique: vi.fn(async () => ({ ...product, status: productStatus })),
    },
    commerceTelegramPublication: {
      findUnique: vi.fn(async () => publication),
      upsert: vi.fn(async () => publication),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (updateCount === 1) Object.assign(publication, data);
        return { count: updateCount };
      }),
      findUniqueOrThrow: vi.fn(async () => publication),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(publication, data)),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  const app = Fastify();
  app.decorate('prisma', prisma as never);
  return { app, prisma, publication };
}

async function ready(app: ReturnType<typeof Fastify>) {
  await app.register(telegramPublicationModule, { prefix: '/api/v1' });
  await app.ready();
}

describe('manual Telegram product publication routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.featureEnabled = false;
  });

  it('requires admin authorization and rejects unauthenticated and normal-user publication requests', async () => {
    const { app } = createApp();
    await ready(app);
    const unauthenticated = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/products/${PRODUCT_ID}/telegram-publish`,
      payload: {},
    });
    expect(unauthenticated.statusCode).toBe(401);
    const normalUser = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/products/${PRODUCT_ID}/telegram-publish`,
      headers: { 'x-test-role': 'user' },
      payload: {},
    });
    expect(normalUser.statusCode).toBe(403);
    expect(mocks.sendTelegramCard).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns FEATURE_DISABLED without calling Telegram when publishing is disabled', async () => {
    const { app } = createApp();
    await ready(app);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/products/${PRODUCT_ID}/telegram-publish`,
      headers: { 'x-test-role': 'admin' },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(mocks.sendTelegramCard).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects unpublished products and unknown products before external transport', async () => {
    mocks.featureEnabled = true;
    const { app } = createApp({ productStatus: 'PENDING_REVIEW' });
    await ready(app);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/products/${PRODUCT_ID}/telegram-publish`,
      headers: { 'x-test-role': 'admin' },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'PRODUCT_NOT_PUBLISHED' });
    expect(mocks.sendTelegramCard).not.toHaveBeenCalled();
    await app.close();

    const { app: unknownApp, prisma } = createApp();
    prisma.commerceProduct.findUnique.mockResolvedValueOnce(null as never);
    await ready(unknownApp);
    const unknownResponse = await unknownApp.inject({
      method: 'POST',
      url: `/api/v1/admin/products/${PRODUCT_ID}/telegram-publish`,
      headers: { 'x-test-role': 'admin' },
      payload: {},
    });
    expect(unknownResponse.statusCode).toBe(404);
    expect(unknownResponse.json()).toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
    expect(mocks.sendTelegramCard).not.toHaveBeenCalled();
    await unknownApp.close();
  });

  it('claims publication atomically and does not send a duplicate for an in-progress record', async () => {
    mocks.featureEnabled = true;
    const { app } = createApp({ updateCount: 0, publicationStatus: 'PUBLISHING' });
    await ready(app);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/products/${PRODUCT_ID}/telegram-publish`,
      headers: { 'x-test-role': 'admin' },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'PUBLICATION_IN_PROGRESS' });
    expect(mocks.sendTelegramCard).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not republish an already published product record', async () => {
    mocks.featureEnabled = true;
    const { app } = createApp({ updateCount: 0, publicationStatus: 'PUBLISHED' });
    await ready(app);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/products/${PRODUCT_ID}/telegram-publish`,
      headers: { 'x-test-role': 'admin' },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'ALREADY_PUBLISHED' });
    expect(mocks.sendTelegramCard).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not expose the configured bot token in publication status responses', async () => {
    const { app } = createApp();
    await ready(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/products/${PRODUCT_ID}/telegram-publication`,
      headers: { 'x-test-role': 'admin' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('test-token-not-for-real-transport');
    expect(response.json()).toMatchObject({ featureEnabled: false, configured: true, status: 'NOT_PUBLISHED' });
    await app.close();
  });

  it('publishes only after an explicit admin request when enabled', async () => {
    mocks.featureEnabled = true;
    const { app } = createApp();
    await ready(app);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/products/${PRODUCT_ID}/telegram-publish`,
      headers: { 'x-test-role': 'admin' },
      payload: { captionOverride: 'Telegram-only caption' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'PUBLISHED', telegramMessageId: 'telegram-message-1' });
    expect(mocks.sendTelegramCard).toHaveBeenCalledOnce();
    await app.close();
  });

  it('stores safe failure state and does not return raw Telegram transport errors', async () => {
    mocks.featureEnabled = true;
    mocks.sendTelegramCard.mockRejectedValueOnce(new Error('bot secret token leaked by remote'));
    const { app, publication } = createApp();
    await ready(app);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/products/${PRODUCT_ID}/telegram-publish`,
      headers: { 'x-test-role': 'admin' },
      payload: {},
    });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('bot secret token');
    expect(response.json()).toMatchObject({ code: 'TELEGRAM_PUBLISH_FAILED', status: 'FAILED' });
    expect(publication).toMatchObject({ status: 'FAILED', errorCode: 'TELEGRAM_PUBLISH_FAILED' });
    await app.close();
  });

  it('blocks a retry when Telegram delivery could not be confirmed', async () => {
    mocks.featureEnabled = true;
    mocks.sendTelegramCard.mockRejectedValueOnce(new TelegramPublishError('TELEGRAM_DELIVERY_UNCONFIRMED'));
    const { app, publication, prisma } = createApp();
    await ready(app);
    const request = {
      method: 'POST' as const,
      url: `/api/v1/admin/products/${PRODUCT_ID}/telegram-publish`,
      headers: { 'x-test-role': 'admin' },
      payload: {},
    };
    const firstResponse = await app.inject(request);
    expect(firstResponse.statusCode).toBe(502);
    expect(publication).toMatchObject({ status: 'FAILED', errorCode: 'TELEGRAM_DELIVERY_UNCONFIRMED' });

    const retryResponse = await app.inject(request);
    expect(retryResponse.statusCode).toBe(409);
    expect(retryResponse.json()).toMatchObject({ code: 'PUBLICATION_UNCONFIRMED' });
    expect(prisma.commerceTelegramPublication.updateMany).toHaveBeenCalledOnce();
    expect(mocks.sendTelegramCard).toHaveBeenCalledOnce();
    await app.close();
  });
});
