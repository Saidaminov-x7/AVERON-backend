// apps/api/src/lib/__tests__/webhooks.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  calculateWebhookSignature,
  sendWebhookRequest,
  dispatchWebhookEvent,
  retryPendingWebhookDeliveries,
} from '../webhookDelivery';
import { createPinnedLookup } from '../safeOutboundUrl';

describe('Webhook Delivery System & Retry Logic', () => {
  const originalFetch = global.fetch;
  const publicResolver = async () => ['93.184.216.34'];

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
    const res = await sendWebhookRequest(
      'https://example.com/webhook',
      payload,
      'mysecret',
      global.fetch,
      publicResolver,
    );

    expect(res.success).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Ijarauz-Event': 'FRAUD_DETECTED',
          'X-Ijarauz-Signature': expect.stringMatching(/^sha256=[a-f0-9]{64}$/),
        }),
      }),
    );
  });

  it('allows an approved public HTTPS endpoint on a custom port', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const result = await sendWebhookRequest(
      'https://hooks.example.com:8080/events',
      { event: 'TEST' },
      undefined,
      fetcher as typeof fetch,
      publicResolver,
    );

    expect(result.success).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      'https://hooks.example.com:8080/events',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('фиксирует ошибку при сетевом сбое', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const payload = { event: 'REPORT_CREATED', data: {} };
    const res = await sendWebhookRequest(
      'https://example.com/hook',
      payload,
      undefined,
      global.fetch,
      publicResolver,
    );

    expect(res.success).toBe(false);
    expect(res.error).toBe('Network error');
  });

  it.each([
    'http://hooks.example.com/events',
    'http://localhost/admin',
    'http://127.0.0.1/',
    'http://10.0.0.8/',
    'http://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd',
  ])('blocks unsafe webhook target %s before making a request', async (url) => {
    global.fetch = vi.fn();
    const result = await sendWebhookRequest(url, { event: 'TEST' }, undefined, global.fetch, publicResolver);
    expect(result).toEqual({ success: false, error: 'Webhook destination is not allowed' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('blocks a public-looking hostname that resolves to a private address', async () => {
    global.fetch = vi.fn();
    const result = await sendWebhookRequest(
      'https://example.com/hook',
      { event: 'TEST' },
      undefined,
      global.fetch,
      async () => ['192.168.1.20'],
    );
    expect(result.success).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('uses only the validated DNS answers after validation, even if DNS changes later', () => {
    const lookup = createPinnedLookup(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
    const callback = vi.fn();

    lookup('hooks.example.com', { all: true }, callback);

    expect(callback).toHaveBeenCalledWith(null, [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
  });

  it('aborts a delivery when the receiver leaves its response body open', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn().mockResolvedValue(new Response(new ReadableStream({
        cancel: () => new Promise<void>(() => undefined),
      }), { status: 200 }));
      const pending = sendWebhookRequest(
        'https://hooks.example.com/events',
        { event: 'TEST' },
        undefined,
        fetcher as typeof fetch,
        publicResolver,
      );

      await vi.advanceTimersByTimeAsync(10000);
      await expect(pending).resolves.toEqual({ success: false, error: 'Delivery timeout after 10000ms' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('создает WebhookDelivery и сохраняет статус SUCCESS при успешной доставке', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const prismaMock = {
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

    const count = await dispatchWebhookEvent(prismaMock as unknown as Parameters<typeof dispatchWebhookEvent>[0], 'FRAUD_DETECTED', { score: 95 }, undefined, publicResolver);

    expect(count).toBe(1);
    expect(prismaMock.webhookDelivery.create).toHaveBeenCalled();
    expect(prismaMock.webhookDelivery.update).toHaveBeenCalledWith({
      where: { id: 'del-1' },
      data: expect.objectContaining({ status: 'SUCCESS', responseCode: 200 }),
    });
  });

  it('повторяет упавшие доставки при запуске retryPendingWebhookDeliveries', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const prismaMock = {
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

    const result = await retryPendingWebhookDeliveries(prismaMock as unknown as Parameters<typeof retryPendingWebhookDeliveries>[0], undefined, publicResolver);

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
