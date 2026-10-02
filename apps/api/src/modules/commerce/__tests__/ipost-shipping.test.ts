import Fastify from 'fastify';
import { fastifyJwt } from '@fastify/jwt';
import { describe, expect, it, vi } from 'vitest';
import type { IPostProvider, IPostShipmentRequest, IPostShipmentResult } from '../../integrations/contracts';
import { createIpostShipment } from '../../integrations/ipost-shipping';
import { createIpostShippingModule } from '../ipost-shipping';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const ORDER_ID = '00000000-0000-4000-8000-000000000002';
const DELIVERY_ID = '00000000-0000-4000-8000-000000000003';
const JWT_SECRET = 'ipost-shipping-route-test-secret-at-least-32-characters';
const initialDelivery = () => ({
  id: DELIVERY_ID,
  method: 'COURIER',
  status: 'PREPARING',
  recipient: 'Buyer',
  phone: '+998901234567',
  destination: { city: 'Tashkent', address: 'Street 1' },
  provider: null as string | null,
  providerReference: null as string | null,
  trackingNumber: null as string | null,
  estimatedDeliveryAt: null as Date | null,
  providerMetadata: null as unknown,
});

function makeProvider() {
  const acceptedRequests = new Map<string, IPostShipmentResult>();
  const createShipment = vi.fn(async (request: IPostShipmentRequest): Promise<IPostShipmentResult> => {
    const existing = acceptedRequests.get(request.idempotencyKey);
    if (existing) return existing;
    const shipment: IPostShipmentResult = {
      providerReference: 'ipost-ref-42',
      trackingNumber: 'IPOST-TRACK-42',
      status: 'PENDING',
      estimatedDeliveryAt: null,
    };
    acceptedRequests.set(request.idempotencyKey, shipment);
    return shipment;
  });
  const getShipment = vi.fn(async (): Promise<IPostShipmentResult> => ({
    providerReference: 'ipost-ref-42',
    trackingNumber: 'IPOST-TRACK-42',
    status: 'DELIVERED',
    estimatedDeliveryAt: null,
  }));
  const provider: IPostProvider = {
    id: 'ipost',
    isEnabled: () => true,
    supportsIdempotentShipmentCreation: () => true,
    createShipment,
    getShipment,
  };
  return { provider, createShipment, getShipment };
}

async function makeApp(provider: IPostProvider | null, delivery = initialDelivery()) {
  const user = {
    findUnique: vi.fn(async () => ({
      role: 'ADMIN',
      adminRole: 'SUPER_ADMIN',
      isBlocked: false,
      isDeleted: false,
    })),
  };
  const commerceDelivery = {
    findUnique: vi.fn(async () => delivery),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(delivery, data);
      return delivery;
    }),
  };
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: DELIVERY_ID }]),
    commerceOrder: {
      findUnique: vi.fn(async () => ({ id: ORDER_ID, delivery })),
    },
    commerceDelivery,
  };
  let transactionQueue = Promise.resolve();
  const prisma = {
    ...tx,
    user,
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      let unlock!: () => void;
      const locked = new Promise<void>((resolve) => { unlock = resolve; });
      const previous = transactionQueue;
      transactionQueue = previous.then(() => locked);
      await previous;
      try {
        return await callback(tx);
      } finally {
        unlock();
      }
    }),
  };
  const app = Fastify();
  app.register(fastifyJwt, { secret: JWT_SECRET });
  app.decorate('prisma', prisma as never);
  app.register(createIpostShippingModule({ provider, isFeatureEnabled: () => provider !== null }), { prefix: '/api/v1' });
  await app.ready();
  const token = app.jwt.sign({ userId: USER_ID, role: 'ADMIN' });
  return { app, token, prisma, delivery };
}

describe('iPost server-side shipping boundary', () => {
  it('creates at most one order shipment and returns the persisted result on retry', async () => {
    const { provider, createShipment } = makeProvider();
    const { app, token, prisma, delivery } = await makeApp(provider);
    const headers = { authorization: `Bearer ${token}` };
    const [first, retry] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/orders/AV-ORDER-42/ipost-shipment',
        headers,
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/orders/AV-ORDER-42/ipost-shipment',
        headers,
      }),
    ]);

    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      provider: 'IPOST',
      providerReference: 'ipost-ref-42',
      trackingNumber: 'IPOST-TRACK-42',
      providerStatus: 'PENDING',
      deliveryStatus: 'PREPARING',
      statusApplied: false,
      idempotentReplay: false,
    });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().idempotentReplay).toBe(true);
    expect(createShipment).toHaveBeenCalledTimes(1);
    expect(createShipment.mock.calls[0][0]).toMatchObject({
      orderId: ORDER_ID,
      recipientName: 'Buyer',
      phone: '+998901234567',
    });
    expect(createShipment.mock.calls[0][0].idempotencyKey).toMatch(/^averon-ipost-[a-f0-9]{64}$/);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(delivery.provider).toBe('IPOST');
    expect(delivery.providerReference).toBe('ipost-ref-42');
    await app.close();
  });

  it('times out provider requests and returns a controlled timeout', async () => {
    vi.useFakeTimers();
    const { provider } = makeProvider();
    const neverResponds: IPostProvider = {
      ...provider,
      createShipment: vi.fn(async () => new Promise<IPostShipmentResult>(() => {})),
    };
    const promise = createIpostShipment(neverResponds, {
      orderId: ORDER_ID,
      recipientName: 'Buyer',
      phone: '+998901234567',
      destination: { city: 'Tashkent' },
    });
    const rejection = expect(promise).rejects.toMatchObject({ code: 'IPOST_TIMEOUT', statusCode: 504 });
    try {
      await vi.advanceTimersByTimeAsync(16_000);
      await rejection;
      expect(neverResponds.createShipment).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports provider DELIVERED as evidence without changing backend delivery truth', async () => {
    const { provider } = makeProvider();
    const delivery = {
      ...initialDelivery(),
      provider: 'IPOST',
      providerReference: 'ipost-ref-42',
      trackingNumber: 'IPOST-TRACK-42',
      providerMetadata: {
        ipost: { status: 'PENDING', estimatedDeliveryAt: null, checkedAt: '2026-10-02T10:00:00.000Z' },
      },
    };
    const { app, token, prisma } = await makeApp(provider, delivery);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/orders/AV-ORDER-42/ipost-shipment',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      providerStatus: 'DELIVERED',
      deliveryStatus: 'PREPARING',
      statusApplied: false,
    });
    expect(delivery.status).toBe('PREPARING');
    expect(prisma.commerceDelivery.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: DELIVERY_ID },
    }));
    await app.close();
  });

  it('does not call a provider or persist shipment state when iPost is disabled', async () => {
    const { provider, createShipment } = makeProvider();
    const { app, token, prisma } = await makeApp({
      ...provider,
      isEnabled: () => false,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/orders/AV-ORDER-42/ipost-shipment',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('IPOST_NOT_CONFIGURED');
    expect(createShipment).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects delivery states that are not ready for provider shipment', async () => {
    const { provider, createShipment } = makeProvider();
    const { app, token, prisma } = await makeApp(provider, { ...initialDelivery(), status: 'PENDING' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/orders/AV-ORDER-42/ipost-shipment',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('DELIVERY_NOT_READY');
    expect(createShipment).not.toHaveBeenCalled();
    expect(prisma.commerceDelivery.update).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns a controlled error for provider failure and malformed normalized states', async () => {
    const { provider } = makeProvider();
    const failing: IPostProvider = {
      ...provider,
      createShipment: vi.fn(async () => {
        throw new Error('provider private error');
      }),
    };
    const { app, token, delivery } = await makeApp(failing);
    const failed = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/orders/AV-ORDER-42/ipost-shipment',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().code).toBe('IPOST_PROVIDER_ERROR');
    expect(failed.body).not.toContain('provider private error');
    expect(delivery.providerReference).toBeNull();
    await app.close();

    const malformed: IPostProvider = {
      ...provider,
      createShipment: vi.fn(async () => ({
        providerReference: 'ipost-ref-43',
        trackingNumber: null,
        status: 'UNKNOWN' as IPostShipmentResult['status'],
        estimatedDeliveryAt: null,
      })),
    };
    const malformedApp = await makeApp(malformed);
    const invalid = await malformedApp.app.inject({
      method: 'POST',
      url: '/api/v1/admin/orders/AV-ORDER-42/ipost-shipment',
      headers: { authorization: `Bearer ${malformedApp.token}` },
    });
    expect(invalid.statusCode).toBe(502);
    expect(invalid.json().code).toBe('IPOST_INVALID_PROVIDER_RESPONSE');
    expect(malformedApp.delivery.providerReference).toBeNull();
    await malformedApp.app.close();
  });
});
