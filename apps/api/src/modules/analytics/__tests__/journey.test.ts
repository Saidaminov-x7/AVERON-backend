import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

vi.mock('../../../lib/adminMiddleware', () => ({ adminMiddleware: async () => undefined }));

import { analyticsModule } from '../index';

describe('customer journey analytics', () => {
  it('aggregates first visits, first paid orders and mature three day conversion', async () => {
    const firstVisits = [
      { deviceId: 'device-1', _min: { createdAt: new Date('2026-10-01T09:00:00.000Z') } },
      { deviceId: 'device-2', _min: { createdAt: new Date('2026-10-02T09:00:00.000Z') } },
      { deviceId: 'device-3', _min: { createdAt: new Date('2026-10-08T09:00:00.000Z') } },
    ];
    const app = Fastify();
    app.decorate('prisma', {
      visitLog: { groupBy: vi.fn(async () => firstVisits) },
      commerceAnalyticsEvent: { findMany: vi.fn(async () => [
        { deviceId: 'device-1', orderId: 'order-1' },
        { deviceId: 'device-2', orderId: 'order-2' },
      ]) },
      commerceOrder: { findMany: vi.fn(async () => [
        {
          id: 'order-1', createdAt: new Date('2026-10-04T09:00:00.000Z'),
          totalRevenue: 100, refundAmount: 0, items: [{ quantity: 1 }],
        },
        {
          id: 'order-2', createdAt: new Date('2026-10-03T09:00:00.000Z'),
          totalRevenue: 200, refundAmount: 0, items: [{ quantity: 2 }],
        },
      ]) },
    } as never);
    await app.register(analyticsModule, { prefix: '/analytics' });

    const response = await app.inject({
      method: 'GET',
      url: '/analytics/admin/journey?from=2026-10-01&to=2026-10-10',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      firstTimeVisitors: 3,
      buyers: 2,
      conversionRate: 2 / 3,
      avgDaysToFirstPurchase: 2,
      avgProductsInFirstOrder: 1.5,
      matureVisitors: 2,
      day3Buyers: 2,
      day3ConversionRate: 1,
    });
    expect(response.json().daily[1]).toMatchObject({ day: '1', purchases: 1, units: 2, revenueUzs: 200 });
    expect(response.json().daily[3]).toMatchObject({ day: '3', purchases: 1, units: 1, revenueUzs: 100 });
    await app.close();
  });
});
