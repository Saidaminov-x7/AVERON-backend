import { createHash } from 'node:crypto';
import type { IPostProvider, IPostShipmentRequest, IPostShipmentResult, ShipmentStatus } from './contracts';

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 2;
const referenceSchema = /^[A-Za-z0-9._:-]{1,160}$/;

export class IPostBoundaryError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code);
    this.name = 'IPostBoundaryError';
  }
}

function stableIdempotencyKey(orderId: string): string {
  return `averon-ipost-${createHash('sha256').update(orderId).digest('hex')}`;
}

function validateShipment(value: unknown): IPostShipmentResult {
  const allowedStatuses: ShipmentStatus[] = ['PENDING', 'IN_TRANSIT', 'DELIVERED', 'FAILED'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IPostBoundaryError('IPOST_INVALID_PROVIDER_RESPONSE', 502);
  }
  const shipment = value as Partial<IPostShipmentResult>;
  if (typeof shipment.providerReference !== 'string' || !referenceSchema.test(shipment.providerReference)
    || (shipment.trackingNumber !== null
      && (typeof shipment.trackingNumber !== 'string' || !referenceSchema.test(shipment.trackingNumber)))
    || typeof shipment.status !== 'string'
    || !allowedStatuses.includes(shipment.status as ShipmentStatus)
    || (shipment.estimatedDeliveryAt !== null
      && (typeof shipment.estimatedDeliveryAt !== 'string' || !Number.isFinite(Date.parse(shipment.estimatedDeliveryAt))))) {
    throw new IPostBoundaryError('IPOST_INVALID_PROVIDER_RESPONSE', 502);
  }
  return {
    providerReference: shipment.providerReference,
    trackingNumber: shipment.trackingNumber,
    status: shipment.status as ShipmentStatus,
    estimatedDeliveryAt: shipment.estimatedDeliveryAt,
  };
}

async function withBoundedRetry<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new IPostBoundaryError('IPOST_TIMEOUT', 504)), { once: true });
        }),
      ]);
    } catch (error) {
      if (error instanceof IPostBoundaryError && error.code === 'IPOST_INVALID_PROVIDER_RESPONSE') throw error;
      if (attempt === MAX_ATTEMPTS) {
        if (error instanceof IPostBoundaryError) throw error;
        throw new IPostBoundaryError('IPOST_PROVIDER_ERROR', 502);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new IPostBoundaryError('IPOST_PROVIDER_ERROR', 502);
}

function ensureProvider(provider: IPostProvider | null): IPostProvider {
  if (!provider || !provider.isEnabled() || !provider.supportsIdempotentShipmentCreation()) {
    throw new IPostBoundaryError('IPOST_NOT_CONFIGURED', 503);
  }
  return provider;
}

export async function createIpostShipment(
  provider: IPostProvider | null,
  request: Omit<IPostShipmentRequest, 'idempotencyKey'>,
): Promise<IPostShipmentResult> {
  const configured = ensureProvider(provider);
  const input: IPostShipmentRequest = {
    ...request,
    idempotencyKey: stableIdempotencyKey(request.orderId),
  };
  return validateShipment(await withBoundedRetry((signal) => configured.createShipment(input, signal)));
}

export async function getIpostShipment(
  provider: IPostProvider | null,
  providerReference: string,
): Promise<IPostShipmentResult> {
  const configured = ensureProvider(provider);
  if (!referenceSchema.test(providerReference)) throw new IPostBoundaryError('IPOST_INVALID_REFERENCE', 400);
  return validateShipment(await withBoundedRetry((signal) => configured.getShipment(providerReference, signal)));
}
