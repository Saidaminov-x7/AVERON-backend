import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgresql://127.0.0.1:5432/test';
  process.env.REDIS_URL = 'redis://127.0.0.1:6379';
  process.env.JWT_SECRET = 'test-jwt-secret-with-more-than-32-characters';
  process.env.REFRESH_SECRET = 'test-refresh-secret-with-more-than-32-characters';
  process.env.NODE_ENV = 'test';
});

import { N8nEventPublisher } from '../n8n-publisher';

describe('n8n event publisher', () => {
  it('signs backend events with a timestamp and stable idempotency key', async () => {
    const event = {
      type: 'order.created' as const,
      orderId: 'order-1',
      occurredAt: '2026-10-01T08:00:00.000Z',
    };
    const body = JSON.stringify(event);
    const secret = 'test-webhook-secret-that-is-at-least-32-characters';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));
    const publisher = new N8nEventPublisher({
      endpoint: 'https://n8n.example.test/webhook/averon',
      secret,
      fetcher,
      now: () => 1_800_000_000_000,
    });

    await publisher.publish(event);

    const [, init] = fetcher.mock.calls[0];
    const headers = new Headers(init?.headers);
    const timestamp = '1800000000';
    expect(headers.get('x-averon-timestamp')).toBe(timestamp);
    expect(headers.get('x-averon-signature')).toBe(
      `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`,
    );
    expect(headers.get('x-averon-event-id')).toBeTruthy();
    expect(init?.body).toBe(body);
    expect(init?.redirect).toBe('error');
  });

  it('does not report failed HTTP delivery as success', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    const publisher = new N8nEventPublisher({
      endpoint: 'https://n8n.example.test/webhook/averon',
      secret: 'test-webhook-secret-that-is-at-least-32-characters',
      fetcher,
    });

    await expect(publisher.publish({
      type: 'order.created',
      orderId: 'order-1',
      occurredAt: '2026-10-01T08:00:00.000Z',
    })).rejects.toThrow('N8N_WEBHOOK_HTTP_503');
  });
});
