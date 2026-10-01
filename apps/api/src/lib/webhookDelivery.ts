// apps/api/src/lib/webhookDelivery.ts
// Сервис безопасной доставки вебхуков с HMAC-подписью и экспоненциальными повторными попытками (Retry backoff)

import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { isSafePublicHttpUrl, type OutboundAddressResolver } from './safeOutboundUrl';

export interface WebhookPayload {
  event: string;
  timestamp: string;
  data: Record<string, any>;
}

// Задержки повторных попыток в миллисекундах: 1 мин, 5 мин, 15 мин, 30 мин, 60 мин
const RETRY_DELAYS_MS = [
  1 * 60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
];

/**
 * Вычисление HMAC-SHA256 подписи для полезной нагрузки вебхука
 */
export function calculateWebhookSignature(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Отправка одного вебхука по HTTP
 */
export async function sendWebhookRequest(
  url: string,
  payload: Record<string, any>,
  secret?: string | null,
  fetcher: typeof fetch = fetch,
  resolveAddresses?: OutboundAddressResolver,
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  if (!await isSafePublicHttpUrl(url, resolveAddresses)) {
    return { success: false, error: 'Webhook destination is not allowed' };
  }
  const jsonString = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Ijarauz-Webhook-Delivery/1.0',
    'X-Ijarauz-Event': payload.event || 'GENERAL',
    'X-Ijarauz-Timestamp': payload.timestamp || new Date().toISOString(),
  };

  if (secret) {
    const signature = calculateWebhookSignature(jsonString, secret);
    headers['X-Ijarauz-Signature'] = `sha256=${signature}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10 секунд таймаут

  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers,
      body: jsonString,
      signal: controller.signal,
      redirect: 'error',
    });

    clearTimeout(timeout);

    if (response.ok) {
      return { success: true, statusCode: response.status };
    }

    return {
      success: false,
      statusCode: response.status,
      error: `HTTP status ${response.status}`,
    };
  } catch (err: any) {
    clearTimeout(timeout);
    return {
      success: false,
      error: err instanceof Error && err.name === 'AbortError'
        ? 'Delivery timeout after 10000ms'
        : 'Network error',
    };
  }
}

/**
 * Отправка события всем активным подписчикам
 */
export async function dispatchWebhookEvent(
  prisma: PrismaClient,
  event: string,
  data: Record<string, any>,
  logger?: any,
  resolveOutboundAddresses?: OutboundAddressResolver,
): Promise<number> {
  try {
    const webhooks = await prisma.systemWebhook.findMany({
      where: {
        isActive: true,
        OR: [
          { events: { has: event } },
          { events: { has: '*' } },
        ],
      },
    });

    if (webhooks.length === 0) return 0;

    const payload: WebhookPayload = {
      event,
      timestamp: new Date().toISOString(),
      data,
    };

    let dispatchedCount = 0;

    for (const webhook of webhooks) {
      const delivery = await prisma.webhookDelivery.create({
        data: {
          webhookId: webhook.id,
          event,
          payload: payload as any,
          attempts: 1,
          maxAttempts: 5,
          status: 'PENDING',
        },
      });

      const res = await sendWebhookRequest(webhook.url, payload, webhook.secret, fetch, resolveOutboundAddresses);

      if (res.success) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'SUCCESS',
            responseCode: res.statusCode || 200,
            lastError: null,
            nextRetryAt: null,
          },
        });
      } else {
        const nextDelay = RETRY_DELAYS_MS[0] || 60000;
        const nextRetryAt = new Date(Date.now() + nextDelay);

        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'FAILED',
            responseCode: res.statusCode || null,
            lastError: res.error || 'Delivery failed',
            nextRetryAt,
          },
        });
      }

      dispatchedCount++;
    }

    return dispatchedCount;
  } catch (err) {
    if (logger) logger.error({ err }, '[Webhook] Error dispatching webhook event');
    return 0;
  }
}

/**
 * Фоновый воркер для повторной доставки упавших вебхуков
 */
export async function retryPendingWebhookDeliveries(
  prisma: PrismaClient,
  logger?: any,
  resolveOutboundAddresses?: OutboundAddressResolver,
): Promise<{ retried: number; succeeded: number; failed: number }> {
  const now = new Date();
  const results = { retried: 0, succeeded: 0, failed: 0 };

  try {
    const pendingDeliveries = await prisma.webhookDelivery.findMany({
      where: {
        status: { in: ['PENDING', 'FAILED'] },
        nextRetryAt: { lte: now },
        attempts: { lt: 5 },
      },
      include: {
        webhook: true,
      },
      take: 20,
    });

    for (const delivery of pendingDeliveries) {
      if (!delivery.webhook || !delivery.webhook.isActive) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: { status: 'CANCELLED', lastError: 'Webhook was deactivated or removed' },
        });
        continue;
      }

      results.retried++;
      const currentAttempt = delivery.attempts + 1;
      const res = await sendWebhookRequest(
        delivery.webhook.url,
        delivery.payload as any,
        delivery.webhook.secret,
        fetch,
        resolveOutboundAddresses,
      );

      if (res.success) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            attempts: currentAttempt,
            status: 'SUCCESS',
            responseCode: res.statusCode || 200,
            lastError: null,
            nextRetryAt: null,
          },
        });
        results.succeeded++;
      } else {
        const isExhausted = currentAttempt >= delivery.maxAttempts;
        const nextDelay = RETRY_DELAYS_MS[Math.min(currentAttempt - 1, RETRY_DELAYS_MS.length - 1)] || 3600000;
        const nextRetryAt = isExhausted ? null : new Date(Date.now() + nextDelay);

        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            attempts: currentAttempt,
            status: isExhausted ? 'EXHAUSTED' : 'FAILED',
            responseCode: res.statusCode || null,
            lastError: res.error || 'Retry attempt failed',
            nextRetryAt,
          },
        });
        results.failed++;
      }
    }
  } catch (err) {
    if (logger) logger.error({ err }, '[Webhook] Error running retryPendingWebhookDeliveries');
  }

  return results;
}
