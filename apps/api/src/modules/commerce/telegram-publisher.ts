type PublishedProduct = { slug: string; salePriceUzs: unknown; translations: unknown };

function productTitle(translations: unknown) {
  if (!translations || typeof translations !== 'object') return 'Новый товар AVERON';
  const data = translations as Record<string, any>;
  return data.ru?.title || data.ru || data.uz?.title || data.uz || data.en?.title || data.en || 'Новый товар AVERON';
}

export async function publishProductToTelegram(product: PublishedProduct, imageUrl?: string) {
  const token = process.env.TELEGRAM_ADMIN_BOT?.trim();
  const channel = process.env.TELEGRAM_CHANNEL_ID?.trim() || '@averon_fashion';
  if (!token || !channel) return { skipped: true };
  const site = (process.env.PUBLIC_SITE_URL || 'https://averon-frontend-three.vercel.app').replace(/\/$/, '');
  const caption = `${productTitle(product.translations)}\n\n${Number(product.salePriceUzs).toLocaleString('ru-RU')} сум\n${site}/ru/catalog/${product.slug}`;
  const method = imageUrl ? 'sendPhoto' : 'sendMessage';
  const body = imageUrl ? { chat_id: channel, photo: imageUrl, caption } : { chat_id: channel, text: caption };
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const errorText = await response.text();
    console.error('[TELEGRAM_PUBLISH_ERROR]', {
      status: response.status,
      statusText: response.statusText,
      errorBody: errorText,
      payload: body,
      channel,
      method,
    });
    throw new Error(`Telegram publish failed [${response.status}]: ${errorText}`);
  }
  return { skipped: false };
}
