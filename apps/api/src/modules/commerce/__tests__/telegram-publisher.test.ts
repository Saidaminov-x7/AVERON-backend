import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ miniAppUrl: 'https://t.me/averon_store/app' }));

vi.mock('../../../config', () => ({
  config: {
    TELEGRAM_MINI_APP_BOT_TOKEN: 'test-token-never-returned',
    get TELEGRAM_MINI_APP_URL() { return mocks.miniAppUrl; },
    PUBLIC_SITE_URL: 'https://shop.example',
  },
}));

import { buildTelegramCard, sendTelegramCard, TelegramPublishError, type TelegramCardProduct } from '../telegram-publisher';

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
    mocks.miniAppUrl = 'https://t.me/averon_store/app';
    vi.unstubAllGlobals();
  });

  it('builds a slug-based Mini App deep link and correctly represents preorder', () => {
    const card = buildTelegramCard(product, { locale: 'en' });
    expect(card.productUrl).toBe('https://t.me/averon_store/app?startapp=p_red-jacket');
    expect(card.availability).toBe('PREORDER');
    expect(card.captionText).toContain('Preorder · 5 available');
    expect(card.estimatedAvailableAt).toBeNull();
    expect(card.productUrl).not.toContain('internal-id');
  });

  it('rejects non-published products and unsafe public identifiers', () => {
    expect(() => buildTelegramCard({ ...product, status: 'PENDING_REVIEW' }, {}))
      .toThrowError(new TelegramPublishError('PRODUCT_NOT_PUBLISHED'));
    expect(() => buildTelegramCard({ ...product, slug: '../private' }, {}))
      .toThrowError(new TelegramPublishError('INVALID_PRODUCT_SLUG'));
  });

  it('rejects unexpected Mini App URLs instead of embedding them in channel messages', () => {
    mocks.miniAppUrl = 'https://evil.example/steal';
    expect(() => buildTelegramCard(product, {}))
      .toThrowError(new TelegramPublishError('INVALID_MINI_APP_URL'));
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

    await expect(sendTelegramCard(card, '@averon_test')).resolves.toBe('42');
    const request = fetchMock.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    const body = JSON.parse(String(request?.body)) as { caption?: string; text?: string };
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
