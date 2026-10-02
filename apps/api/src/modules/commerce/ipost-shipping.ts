import type { Prisma } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { adminMiddleware } from '../../lib/adminMiddleware';
import { featureFlags } from '../features/feature-flags';
import type { IPostProvider, IPostShipmentResult } from '../integrations/contracts';
import { createIpostShipment, getIpostShipment, IPostBoundaryError } from '../integrations/ipost-shipping';

const orderParamsSchema = z.object({
  orderNumber: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
const deliveryDestinationSchema = z.object({
  city: z.string().trim().min(1).max(100),
  address: z.string().trim().min(1).max(500),
  district: z.string().trim().max(100).optional(),
  apartment: z.string().trim().max(100).optional(),
  entrance: z.string().trim().max(50).optional(),
  floor: z.string().trim().max(50).optional(),
  postalCode: z.string().trim().max(30).optional(),
  deliveryInstructions: z.string().trim().max(500).optional(),
  comment: z.string().trim().max(500).optional(),
}).strict();

type IpostStatusSnapshot = {
  status: IPostShipmentResult['status'];
  estimatedDeliveryAt: string | null;
  checkedAt: string;
};

function safeIpostSnapshot(value: Prisma.JsonValue | null): IpostStatusSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ipost = value.ipost;
  if (!ipost || typeof ipost !== 'object' || Array.isArray(ipost)) return null;
  const snapshot = ipost as Record<string, unknown>;
  if (!['PENDING', 'IN_TRANSIT', 'DELIVERED', 'FAILED'].includes(String(snapshot.status))
    || typeof snapshot.checkedAt !== 'string'
    || (snapshot.estimatedDeliveryAt !== null && typeof snapshot.estimatedDeliveryAt !== 'string')) return null;
  return {
    status: snapshot.status as IpostStatusSnapshot['status'],
    estimatedDeliveryAt: snapshot.estimatedDeliveryAt as string | null,
    checkedAt: snapshot.checkedAt,
  };
}

function metadataWithIpost(
  existing: Prisma.JsonValue | null,
  snapshot: IpostStatusSnapshot,
): Prisma.InputJsonObject {
  const metadata: Prisma.InputJsonObject = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing as Prisma.InputJsonObject
    : {};
  return { ...metadata, ipost: snapshot };
}

function destinationRecord(value: Prisma.JsonValue): Record<string, unknown> {
  const result = deliveryDestinationSchema.safeParse(value);
  if (!result.success) {
    throw new IPostBoundaryError('IPOST_DELIVERY_CONTACT_MISSING', 409);
  }
  return result.data;
}

export function createIpostShippingModule(options: {
  provider: IPostProvider | null;
  isFeatureEnabled?: () => boolean;
}): FastifyPluginAsync {
  const isFeatureEnabled = options.isFeatureEnabled ?? (() => featureFlags.isEnabled('IPOST'));

  return async (app) => {
    app.post<{ Params: { orderNumber: string } }>('/admin/orders/:orderNumber/ipost-shipment', {
      preHandler: adminMiddleware,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    }, async (request, reply) => {
      const parsedParams = orderParamsSchema.safeParse(request.params);
      if (!parsedParams.success) return reply.status(400).send({ code: 'INVALID_ORDER_NUMBER', message: 'Invalid order number' });
      if (!isFeatureEnabled() || !options.provider?.isEnabled()) {
        return reply.status(503).send({ code: 'IPOST_NOT_CONFIGURED', message: 'iPost shipping is not configured' });
      }

      try {
        const result = await app.prisma.$transaction(async (tx) => {
          const order = await tx.commerceOrder.findUnique({
            where: { orderNumber: parsedParams.data.orderNumber },
            select: {
              id: true,
              delivery: {
                select: {
                  id: true,
                  method: true,
                  status: true,
                  recipient: true,
                  phone: true,
                  destination: true,
                  provider: true,
                  providerReference: true,
                  trackingNumber: true,
                  estimatedDeliveryAt: true,
                  providerMetadata: true,
                },
              },
            },
          });
          if (!order) return { error: 'ORDER_NOT_FOUND' as const };
          if (!order.delivery) return { error: 'DELIVERY_NOT_FOUND' as const };

          await tx.$queryRaw`SELECT "id" FROM "CommerceDelivery" WHERE "id" = ${order.delivery.id} FOR UPDATE`;
          const delivery = await tx.commerceDelivery.findUnique({
            where: { id: order.delivery.id },
            select: {
              id: true,
              method: true,
              status: true,
              recipient: true,
              phone: true,
              destination: true,
              provider: true,
              providerReference: true,
              trackingNumber: true,
              estimatedDeliveryAt: true,
              providerMetadata: true,
            },
          });
          if (!delivery) return { error: 'DELIVERY_NOT_FOUND' as const };

          const previousSnapshot = safeIpostSnapshot(delivery.providerMetadata);
          if (delivery.provider === 'IPOST' && delivery.providerReference && previousSnapshot) {
            return {
              delivery,
              snapshot: previousSnapshot,
              idempotentReplay: true,
            };
          }
          if (delivery.method !== 'COURIER' || delivery.status !== 'PREPARING') {
            return { error: 'DELIVERY_NOT_READY' as const };
          }
          if (!delivery.recipient.trim() || delivery.recipient.trim().length > 100
            || !/^[+0-9 ()-]{7,32}$/.test(delivery.phone)) {
            return { error: 'IPOST_DELIVERY_CONTACT_MISSING' as const };
          }

          const shipment = await createIpostShipment(options.provider, {
            orderId: order.id,
            recipientName: delivery.recipient.trim(),
            phone: delivery.phone,
            destination: destinationRecord(delivery.destination),
          });
          const snapshot: IpostStatusSnapshot = {
            status: shipment.status,
            estimatedDeliveryAt: shipment.estimatedDeliveryAt,
            checkedAt: new Date().toISOString(),
          };
          const updated = await tx.commerceDelivery.update({
            where: { id: delivery.id },
            data: {
              provider: 'IPOST',
              providerReference: shipment.providerReference,
              trackingNumber: shipment.trackingNumber,
              estimatedDeliveryAt: shipment.estimatedDeliveryAt ? new Date(shipment.estimatedDeliveryAt) : null,
              providerMetadata: metadataWithIpost(delivery.providerMetadata, snapshot),
            },
            select: { id: true },
          });
          return { delivery: { ...delivery, ...updated }, snapshot, idempotentReplay: false, shipment };
        }, { maxWait: 5_000, timeout: 20_000 });

        if ('error' in result) {
          const status = result.error === 'ORDER_NOT_FOUND' ? 404 : 409;
          return reply.status(status).send({ code: result.error, message: result.error });
        }
        return {
          provider: 'IPOST',
          providerReference: result.delivery.providerReference ?? result.shipment?.providerReference ?? null,
          trackingNumber: result.delivery.trackingNumber ?? result.shipment?.trackingNumber ?? null,
          providerStatus: result.snapshot.status,
          deliveryStatus: result.delivery.status,
          statusApplied: false,
          estimatedDeliveryAt: result.snapshot.estimatedDeliveryAt,
          checkedAt: result.snapshot.checkedAt,
          idempotentReplay: result.idempotentReplay,
        };
      } catch (error) {
        if (error instanceof IPostBoundaryError) {
          if (error.statusCode >= 500) request.log.warn({ code: error.code }, 'iPost shipment request failed');
          return reply.status(error.statusCode).send({ code: error.code, message: error.code });
        }
        if (typeof error === 'object' && error !== null && 'code' in error &&
          (error as { code: string }).code === 'P2002') {
          return reply.status(409).send({ code: 'IPOST_SHIPMENT_CONFLICT', message: 'iPost shipment already exists' });
        }
        request.log.error({ errorName: error instanceof Error ? error.name : 'unknown' }, 'Unable to create iPost shipment');
        return reply.status(500).send({ code: 'IPOST_SHIPMENT_FAILED', message: 'Unable to create shipment' });
      }
    });

    app.get<{ Params: { orderNumber: string } }>('/admin/orders/:orderNumber/ipost-shipment', {
      preHandler: adminMiddleware,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    }, async (request, reply) => {
      const parsedParams = orderParamsSchema.safeParse(request.params);
      if (!parsedParams.success) return reply.status(400).send({ code: 'INVALID_ORDER_NUMBER', message: 'Invalid order number' });
      if (!isFeatureEnabled() || !options.provider?.isEnabled()) {
        return reply.status(503).send({ code: 'IPOST_NOT_CONFIGURED', message: 'iPost shipping is not configured' });
      }

      try {
        const order = await app.prisma.commerceOrder.findUnique({
          where: { orderNumber: parsedParams.data.orderNumber },
          select: {
            id: true,
            delivery: {
              select: {
                id: true,
                status: true,
                provider: true,
                providerReference: true,
                trackingNumber: true,
                providerMetadata: true,
              },
            },
          },
        });
        if (!order) return reply.status(404).send({ code: 'ORDER_NOT_FOUND', message: 'Order not found' });
        const delivery = order.delivery;
        if (!delivery || delivery.provider !== 'IPOST' || !delivery.providerReference) {
          return reply.status(409).send({ code: 'IPOST_SHIPMENT_NOT_FOUND', message: 'iPost shipment was not created' });
        }

        const shipment = await getIpostShipment(options.provider, delivery.providerReference);
        const snapshot: IpostStatusSnapshot = {
          status: shipment.status,
          estimatedDeliveryAt: shipment.estimatedDeliveryAt,
          checkedAt: new Date().toISOString(),
        };
        await app.prisma.commerceDelivery.update({
          where: { id: delivery.id },
          data: {
            trackingNumber: shipment.trackingNumber,
            estimatedDeliveryAt: shipment.estimatedDeliveryAt ? new Date(shipment.estimatedDeliveryAt) : null,
            providerMetadata: metadataWithIpost(delivery.providerMetadata, snapshot),
          },
        });
        return {
          provider: 'IPOST',
          providerReference: shipment.providerReference,
          trackingNumber: shipment.trackingNumber,
          providerStatus: shipment.status,
          deliveryStatus: delivery.status,
          statusApplied: false,
          estimatedDeliveryAt: shipment.estimatedDeliveryAt,
          checkedAt: snapshot.checkedAt,
        };
      } catch (error) {
        if (error instanceof IPostBoundaryError) {
          if (error.statusCode >= 500) request.log.warn({ code: error.code }, 'iPost tracking lookup failed');
          return reply.status(error.statusCode).send({ code: error.code, message: error.code });
        }
        request.log.error({ errorName: error instanceof Error ? error.name : 'unknown' }, 'Unable to look up iPost shipment');
        return reply.status(500).send({ code: 'IPOST_LOOKUP_FAILED', message: 'Unable to look up shipment' });
      }
    });
  };
}

export const ipostShippingModule = createIpostShippingModule({ provider: null });
