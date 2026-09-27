// apps/api/src/lib/__tests__/webhooks.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  calculateWebhookSignature,
  sendWebhookRequest,
  dispatchWebhookEvent,
  retryPendingWebhookDeliveries,
} from '../webhookDelivery';

describe('Webhook Delivery System & Retry Logic', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('корректно генерирует HMAC SHA-256 подпись', () => {
    const payload = JSON.stringify({ event: 'TEST_EVENT', data: { id: 1 } });
    const secret = 'super_webhook_secret_key';

    const sig1 = calculateWebhookSignature(payload, secret);
    const sig2 = calculateWebhookSignature(payload, secret);

    expect(sig1).toBe(sig2);
    expect(sig1).toHaveLength(64); // SHA-256 hex length
  });

  it('отправляет POST запрос с корректными заголовками и подписью', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });

    const payload = { event: 'FRAUD_DETECTED', data: { listingId: '123' } };
    const res = await sendWebhookRequest('https://example.com/webhook', payload, 'mysecret');

    expect(res.success).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Ijarauz-Event': 'FRAUD_DETECTED',
          'X-Ijarauz-Signature': expect.stringMatching(/^sha256=[a-f0-9]{64}$/),
        }),
      }),
    );
  });

  it('фиксирует ошибку при сетевом сбое', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const payload = { event: 'REPORT_CREATED', data: {} };
    const res = await sendWebhookRequest('https://invalid.domain/hook', payload);

    expect(res.success).toBe(false);
    expect(res.error).toContain('Connection refused');
  });

  it('создает WebhookDelivery и сохраняет статус SUCCESS при успешной доставке', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const prismaMock: any = {
      systemWebhook: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'wh-1', url: 'https://api.crm.uz/hook', secret: 'sec', isActive: true, events: ['FRAUD_DETECTED'] },
        ]),
      },
      webhookDelivery: {
        create: vi.fn().mockResolvedValue({ id: 'del-1' }),
        update: vi.fn().mockResolvedValue({}),
      },
    };

    const count = await dispatchWebhookEvent(prismaMock, 'FRAUD_DETECTED', { score: 95 });

    expect(count).toBe(1);
    expect(prismaMock.webhookDelivery.create).toHaveBeenCalled();
    expect(prismaMock.webhookDelivery.update).toHaveBeenCalledWith({
      where: { id: 'del-1' },
      data: expect.objectContaining({ status: 'SUCCESS', responseCode: 200 }),
    });
  });

  it('повторяет упавшие доставки при запуске retryPendingWebhookDeliveries', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const prismaMock: any = {
      webhookDelivery: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'del-retry-1',
            attempts: 1,
            maxAttempts: 5,
            payload: { event: 'PAYMENT_RECEIVED' },
            webhook: { id: 'wh-1', url: 'https://payment.uz/hook', secret: null, isActive: true },
          },
        ]),
        update: vi.fn().mockResolvedValue({}),
      },
    };

    const result = await retryPendingWebhookDeliveries(prismaMock);

    expect(result.retried).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(prismaMock.webhookDelivery.update).toHaveBeenCalledWith({
      where: { id: 'del-retry-1' },
      data: expect.objectContaining({
        attempts: 2,
        status: 'SUCCESS',
        nextRetryAt: null,
      }),
    });
  });
});
