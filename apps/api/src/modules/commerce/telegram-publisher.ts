import { isIP } from 'node:net';
import { config } from '../../config';

type CardVariant = { stock: number; active: boolean };

export type TelegramCardProduct = {
  id: string;
  slug: string;
  status: string;
  translations: unknown;
  description: unknown;
  salePriceUzs: unknown;
  stock: number;
  preorderEnabled: boolean;
  preorderLimit: number;
  preorderReserved: number;
  preorderEstimatedAt: Date | null;
  images: Array<{ url: string }>;
  variants: CardVariant[];
};

export type TelegramCard = {
  title: string;
  description: string;
  priceUzs: string;
  availability: 'IN_STOCK' | 'LOW_STOCK' | 'PREORDER' | 'OUT_OF_STOCK';
  estimatedAvailableAt: string | null;
  imageUrl: string | null;
  productUrl: string;
  captionText: string;
  buttonText: string;
};

export class TelegramPublishError extends Error {
  constructor(readonly code: string, readonly details?: string) {
    super(code);
    this.name = 'TelegramPublishError';
  }
}

function localized(value: unknown, locale: 'ru' | 'uz' | 'en', field: 'title' | 'description'): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  const selected = record[locale] ?? record.ru ?? record.uz ?? record.en;
  if (typeof selected === 'string') return selected.trim();
  if (selected && typeof selected === 'object' && !Array.isArray(selected)) {
    const entry = selected as Record<string, unknown>;
    const text = entry[field] ?? entry.text;
    return typeof text === 'string' ? text.trim() : '';
  }
  return '';
}

function isSafeTelegramPhotoUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      isIP(host) === 0 &&
      host !== 'localhost' &&
      !host.endsWith('.localhost') &&
      !host.endsWith('.local') &&
      host.includes('.');
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!);
}

export function buildTelegramCard(
  product: TelegramCardProduct,
  options: { locale?: 'ru' | 'uz' | 'en'; captionOverride?: string },
): TelegramCard {
  if (product.status !== 'PUBLISHED') throw new TelegramPublishError('PRODUCT_NOT_PUBLISHED');
  if (!/^[a-z0-9][a-z0-9-]{0,119}$/i.test(product.slug)) throw new TelegramPublishError('INVALID_PRODUCT_SLUG');

  const locale = options.locale ?? 'ru';
  const translations = product.translations;
  const title = localized(translations, locale, 'title') ||
    (translations && typeof translations === 'object' && !Array.isArray(translations)
      ? localized((translations as Record<string, unknown>)[locale], locale, 'title')
      : '') ||
    product.slug;
  const description = localized(product.description, locale, 'description') ||
    (translations && typeof translations === 'object' && !Array.isArray(translations)
      ? localized((translations as Record<string, unknown>)[locale], locale, 'description')
      : '');
  const variantStock = product.variants.filter((variant) => variant.active).reduce((sum, variant) => sum + Math.max(0, variant.stock), 0);
  const stock = product.variants.length > 0 ? variantStock : Math.max(0, product.stock);
  const preorderAvailable = product.preorderEnabled
    ? Math.max(0, product.preorderLimit - product.preorderReserved)
    : 0;
  const availability = stock > 5
    ? 'IN_STOCK'
    : stock > 0
      ? 'LOW_STOCK'
      : preorderAvailable > 0
        ? 'PREORDER'
        : 'OUT_OF_STOCK';

  const labels = {
    ru: { inStock: 'В наличии', lowStock: `Осталось: ${stock}`, preorder: `Предзаказ · доступно ${preorderAvailable}`, out: 'Нет в наличии', price: 'Цена', button: 'Открыть товар' },
    uz: { inStock: 'Mavjud', lowStock: `Qoldi: ${stock}`, preorder: `Oldindan buyurtma · ${preorderAvailable} dona`, out: 'Mavjud emas', price: 'Narx', button: 'Mahsulotni ochish' },
    en: { inStock: 'In stock', lowStock: `Only ${stock} left`, preorder: `Preorder · ${preorderAvailable} available`, out: 'Out of stock', price: 'Price', button: 'Open product' },
  }[locale];
  const availabilityText = availability === 'IN_STOCK'
    ? labels.inStock
    : availability === 'LOW_STOCK'
      ? labels.lowStock
      : availability === 'PREORDER'
        ? labels.preorder
        : labels.out;
  const miniAppUrl = config.TELEGRAM_MINI_APP_URL?.trim();
  let productUrl: URL;
  if (miniAppUrl) {
    productUrl = new URL(miniAppUrl);
    if (
      productUrl.protocol !== 'https:' ||
      productUrl.hostname !== 't.me' ||
      productUrl.username ||
      productUrl.password ||
      productUrl.search ||
      productUrl.hash ||
      !/^\/[A-Za-z0-9_]{5,32}\/[A-Za-z0-9_-]{1,64}$/.test(productUrl.pathname)
    ) throw new TelegramPublishError('INVALID_MINI_APP_URL');
    productUrl.searchParams.set('startapp', `p_${product.slug}`);
  } else {
    productUrl = new URL(`/${locale}/mini-app`, config.PUBLIC_SITE_URL);
    productUrl.searchParams.set('product', product.slug);
  }
  const price = Number(product.salePriceUzs);
  if (!Number.isFinite(price) || price < 0) throw new TelegramPublishError('INVALID_PRODUCT_PRICE');
  const override = options.captionOverride?.trim();
  const summary = (override || description).slice(0, 700);
  const captionText = [
    title,
    summary,
    `${labels.price}: ${price.toLocaleString(locale === 'en' ? 'en-US' : locale === 'uz' ? 'uz-UZ' : 'ru-RU')} UZS`,
    availabilityText,
    productUrl.toString(),
  ].filter(Boolean).join('\n\n').slice(0, 1024);

  const image = product.images[0]?.url;
  if (image && !isSafeTelegramPhotoUrl(image)) throw new TelegramPublishError('INVALID_PRODUCT_IMAGE_URL');
  return {
    title,
    description: summary,
    priceUzs: price.toLocaleString(locale === 'en' ? 'en-US' : locale === 'uz' ? 'uz-UZ' : 'ru-RU'),
    availability,
    estimatedAvailableAt: availability === 'PREORDER' ? product.preorderEstimatedAt?.toISOString() ?? null : null,
    imageUrl: image ?? null,
    productUrl: productUrl.toString(),
    captionText,
    buttonText: labels.button,
  };
}

export async function sendTelegramCard(card: TelegramCard, channelId: string): Promise<string> {
  const token = config.TELEGRAM_MINI_APP_BOT_TOKEN?.trim() || config.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new TelegramPublishError('TELEGRAM_NOT_CONFIGURED');
  if (!/^@[A-Za-z0-9_]{5,32}$/.test(channelId) && !/^-100\d{5,20}$/.test(channelId)) {
    throw new TelegramPublishError('TELEGRAM_CHANNEL_NOT_CONFIGURED');
  }

  const htmlCaption = escapeHtml(card.captionText);
  const method = card.imageUrl ? 'sendPhoto' : 'sendMessage';
  const content = card.imageUrl
    ? { chat_id: channelId, photo: card.imageUrl, caption: htmlCaption, parse_mode: 'HTML' }
    : { chat_id: channelId, text: htmlCaption, parse_mode: 'HTML' };
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...content,
        reply_markup: {
          inline_keyboard: [[{ text: card.buttonText, url: card.productUrl }]],
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new TelegramPublishError('TELEGRAM_DELIVERY_UNCONFIRMED');
  }

  let result: { ok?: boolean; result?: { message_id?: number }; description?: string } | null = null;
  try {
    result = await response.json() as { ok?: boolean; result?: { message_id?: number }; description?: string };
  } catch {
    throw new TelegramPublishError('TELEGRAM_DELIVERY_UNCONFIRMED');
  }
  if (!response.ok) {
    if (response.status >= 500) throw new TelegramPublishError('TELEGRAM_DELIVERY_UNCONFIRMED', result?.description);
    throw new TelegramPublishError(response.status === 429 ? 'TELEGRAM_RATE_LIMITED' : 'TELEGRAM_REJECTED', result?.description);
  }
  if (result?.ok === false) throw new TelegramPublishError('TELEGRAM_REJECTED', result.description);
  if (result?.ok !== true || !Number.isSafeInteger(result.result?.message_id) || !result.result?.message_id) {
    throw new TelegramPublishError('TELEGRAM_DELIVERY_UNCONFIRMED');
  }
  return String(result.result.message_id);
}
