import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adminBotToken: 'admin-token',
  productBotToken: 'product-token',
  miniAppBotToken: undefined as string | undefined,
  channelId: '@averon_fashion',
}));

vi.mock('../../../config', () => ({
  config: {
    get TELEGRAM_ADMIN_BOT() { return mocks.adminBotToken; },
    get TELEGRAM_BOT_TOKEN() { return mocks.productBotToken; },
    get TELEGRAM_MINI_APP_BOT_TOKEN() { return mocks.miniAppBotToken; },
    get TELEGRAM_CHANNEL_ID() { return mocks.channelId; },
    PUBLIC_SITE_URL: 'https://shop.example',
  },
}));

import { buildTelegramCard, isTelegramProductPublisherConfigured, sendTelegramCard, TelegramPublishError, type TelegramCardProduct } from '../telegram-publisher';

const product: TelegramCardProduct = {
  id: 'internal-id',
  slug: 'red-jacket',
  status: 'PUBLISHED',
  translations: { en: { title: '<script>alert("x")</script> Jacket' } },
  description: { en: { description: 'A <b>nice</b> jacket & coat' } },
  salePriceUzs: '125000',
  stock: 0,
  preorderEnabled: true,
  preorderLimit: 8,
  preorderReserved: 3,
  preorderEstimatedAt: null,
  images: [{ url: 'https://cdn.example/image.jpg' }],
  variants: [],
};

describe('Telegram product cards', () => {
  afterEach(() => {
    mocks.adminBotToken = 'admin-token';
    mocks.productBotToken = 'product-token';
    mocks.miniAppBotToken = undefined;
    mocks.channelId = '@averon_fashion';
    vi.unstubAllGlobals();
  });

  it('links to the AVERON storefront product page and correctly represents preorder', () => {
    const card = buildTelegramCard(product, { locale: 'en' });
    expect(card.productUrl).toBe('https://shop.example/en/catalog/red-jacket');
    expect(card.availability).toBe('PREORDER');
    expect(card.captionText).toContain('Preorder · 5 available');
    expect(card.captionText).toContain('💰 Price: 125,000 UZS');
    expect(card.captionText).not.toContain('/mini-app');
    expect(card.captionHtml).toContain('<b>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; Jacket</b>');
    expect(card.captionHtml).toContain('<i>📦 Preorder · 5 available</i>');
    expect(card.estimatedAvailableAt).toBeNull();
    expect(card.productUrl).not.toContain('internal-id');
  });

  it('uses the dedicated admin bot token for product publication', () => {
    expect(isTelegramProductPublisherConfigured()).toBe(true);
  });

  it('does not fall back to the 2FA/general or Mini App bot token for product posts', async () => {
    mocks.adminBotToken = '';
    mocks.productBotToken = 'general-or-2fa-token';
    mocks.miniAppBotToken = 'mini-app-token';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(isTelegramProductPublisherConfigured()).toBe(false);
    await expect(sendTelegramCard(buildTelegramCard(product, { locale: 'en' }), '@averon_fashion'))
      .rejects.toThrowError(new TelegramPublishError('TELEGRAM_NOT_CONFIGURED'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-published products and unsafe public identifiers', () => {
    expect(() => buildTelegramCard({ ...product, status: 'PENDING_REVIEW' }, {}))
      .toThrowError(new TelegramPublishError('PRODUCT_NOT_PUBLISHED'));
    expect(() => buildTelegramCard({ ...product, slug: '../private' }, {}))
      .toThrowError(new TelegramPublishError('INVALID_PRODUCT_SLUG'));
  });

  it('allows publication only to the AVERON | UK WEAR group', async () => {
    mocks.channelId = '@another_channel';
    expect(isTelegramProductPublisherConfigured()).toBe(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendTelegramCard(buildTelegramCard(product, {}), '@another_channel'))
      .rejects.toThrowError(new TelegramPublishError('TELEGRAM_CHANNEL_NOT_ALLOWED'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('escapes hostile product and caption text before mocked Telegram transport', async () => {
    const card = buildTelegramCard(product, {
      locale: 'en',
      captionOverride: '<b>Click</b> & "buy"',
    });
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => new Response(JSON.stringify({
      ok: true,
      result: { message_id: 42 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendTelegramCard(card, '@averon_fashion')).resolves.toBe('42');
    const request = fetchMock.mock.calls[0]?.[1];
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/botadmin-token/sendPhoto');
    expect(request).toBeDefined();
    const body = JSON.parse(String(request?.body)) as {
      caption?: string;
      text?: string;
      reply_markup?: { inline_keyboard?: Array<Array<{ url?: string }>> };
    };
    expect(body.reply_markup?.inline_keyboard?.[0]?.[0]?.url).toBe('https://shop.example/en/catalog/red-jacket');
    const sentText = body.caption ?? body.text ?? '';
    expect(sentText).toContain('&lt;b&gt;Click&lt;/b&gt; &amp; &quot;buy&quot;');
    expect(sentText).not.toContain('<script>');
    expect(sentText).not.toContain('<b>Click</b>');
  });

  it('rejects unsafe image URLs without issuing a transport request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(() => buildTelegramCard({
      ...product,
      images: [{ url: 'https://127.0.0.1/private.jpg' }],
    }, {})).toThrowError(new TelegramPublishError('INVALID_PRODUCT_IMAGE_URL'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
