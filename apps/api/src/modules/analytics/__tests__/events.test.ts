import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { Prisma } from '@prisma/client';
import { analyticsModule, commerceEventSchema } from '../index';

const validEvent = {
  eventId: '00000000-0000-4000-8000-000000000001',
  deviceId: '00000000-0000-4000-8000-000000000002',
  eventName: 'product_view',
  path: '/ru/catalog/test-product',
  metadata: { productId: '00000000-0000-4000-8000-000000000003' },
};

describe('commerce analytics event contract', () => {
  it('accepts allowlisted events with bounded metadata', () => {
    expect(commerceEventSchema.safeParse({
      ...validEvent,
      eventName: 'catalog_search',
      metadata: { country: 'CN', queryLength: 20, resultCount: 12 },
    }).success).toBe(true);
  });

  describe('commerce analytics event endpoint', () => {
    async function buildApp(options?: {
      order?: { status: string; totalRevenue: Prisma.Decimal; refundAmount: Prisma.Decimal } | null;
    }) {
      const app = Fastify();
      const create = vi.fn(async () => ({}));
      const findOrder = vi.fn(async () => options?.order ?? null);
      app.decorate('prisma', {
        commerceAnalyticsEvent: { create },
        commerceOrder: { findUnique: findOrder },
      } as never);
      await app.register(analyticsModule, { prefix: '/analytics' });
      return { app, create, findOrder };
    }

    it('records allowed events and returns no analytics payload', async () => {
      const { app, create } = await buildApp();
      const response = await app.inject({
        method: 'POST',
        url: '/analytics/events',
        payload: { ...validEvent, metadata: { productId: validEvent.metadata.productId, country: 'CN' } },
      });

      expect(response.statusCode).toBe(204);
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          eventName: 'product_view',
          metadata: { productId: validEvent.metadata.productId, country: 'CN' },
          productId: validEvent.metadata.productId,
          productViewDayKey: expect.any(String),
        }),
      }));
      expect(response.body).toBe('');
      await app.close();
    });

    it('uses the paid order record for purchase revenue, never request-provided totals', async () => {
      const { app, create, findOrder } = await buildApp({
        order: {
          status: 'PAID',
          totalRevenue: new Prisma.Decimal(120000),
          refundAmount: new Prisma.Decimal(20000),
        },
      });
      const response = await app.inject({
        method: 'POST',
        url: '/analytics/events',
        payload: {
          ...validEvent,
          eventName: 'purchase',
          orderId: '00000000-0000-4000-8000-000000000003',
        },
      });

      expect(response.statusCode).toBe(204);
      expect(findOrder).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: '00000000-0000-4000-8000-000000000003' },
      }));
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ revenueUzs: new Prisma.Decimal(100000) }),
      }));
      await app.close();
    });

    it('does not persist private paths or invalid metadata', async () => {
      const { app, create } = await buildApp();
      const privateResponse = await app.inject({
        method: 'POST',
        url: '/analytics/events',
        payload: { ...validEvent, path: '/ru/checkout' },
      });
      const invalidResponse = await app.inject({
        method: 'POST',
        url: '/analytics/events',
        payload: { ...validEvent, metadata: { phoneNumber: 'not-accepted' } },
      });

      expect(privateResponse.statusCode).toBe(204);
      expect(invalidResponse.statusCode).toBe(400);
      expect(create).not.toHaveBeenCalled();
      await app.close();
    });
  });

  it('rejects unknown events, metadata, and browser-supplied revenue', () => {
    expect(commerceEventSchema.safeParse({ ...validEvent, eventName: 'unknown' }).success).toBe(false);
    expect(commerceEventSchema.safeParse({ ...validEvent, metadata: { email: 'customer@example.com' } }).success).toBe(false);
    expect(commerceEventSchema.safeParse({ ...validEvent, revenueUzs: 100000 }).success).toBe(false);
  });

  it('requires an order ID for purchase events and rejects order IDs for other events', () => {
    expect(commerceEventSchema.safeParse({ ...validEvent, eventName: 'purchase' }).success).toBe(false);
    expect(commerceEventSchema.safeParse({
      ...validEvent,
      eventName: 'purchase',
      orderId: '00000000-0000-4000-8000-000000000003',
    }).success).toBe(true);
    expect(commerceEventSchema.safeParse({
      ...validEvent,
      orderId: '00000000-0000-4000-8000-000000000003',
    }).success).toBe(false);
  });
});
