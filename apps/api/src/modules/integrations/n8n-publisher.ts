import { createHash, createHmac } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config';
import { featureFlags } from '../features/feature-flags';
import { domainEventBus } from './domain-events';
import type { AveronDomainEvent } from './contracts';

const FAILURE_QUEUE_KEY = 'averon:v1:n8n:failed-events';
const FAILURE_QUEUE_LIMIT = 100;

type N8nPublisherOptions = {
  endpoint: string;
  secret: string;
  fetcher?: typeof fetch;
  now?: () => number;
};

export class N8nEventPublisher {
  constructor(private readonly options: N8nPublisherOptions) {}

  async publish(event: AveronDomainEvent): Promise<void> {
    const body = JSON.stringify(event);
    const timestamp = String(Math.floor((this.options.now?.() ?? Date.now()) / 1000));
    const signature = createHmac('sha256', this.options.secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    const eventId = createHash('sha256').update(body).digest('hex');
    const response = await (this.options.fetcher ?? fetch)(this.options.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-averon-timestamp': timestamp,
        'x-averon-signature': `sha256=${signature}`,
        'x-averon-event-id': eventId,
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`N8N_WEBHOOK_HTTP_${response.status}`);
  }
}

export function registerN8nEventPublisher(redis: Redis, logger: FastifyBaseLogger): () => void {
  if (!featureFlags.isEnabled('N8N') || !config.N8N_WEBHOOK_URL || !config.N8N_WEBHOOK_SECRET) {
    return () => undefined;
  }

  const publisher = new N8nEventPublisher({
    endpoint: config.N8N_WEBHOOK_URL,
    secret: config.N8N_WEBHOOK_SECRET,
  });
  return domainEventBus.subscribe(async (event) => {
    try {
      await publisher.publish(event);
    } catch (error) {
      const errorCode = error instanceof Error && /^N8N_WEBHOOK_HTTP_\d{3}$/.test(error.message)
        ? error.message
        : 'N8N_WEBHOOK_DELIVERY_FAILED';
      logger.warn({ eventType: event.type, errorCode }, 'n8n event delivery failed');
      try {
        await redis.lpush(FAILURE_QUEUE_KEY, JSON.stringify({
          event,
          failedAt: new Date().toISOString(),
          errorCode,
        }));
        await redis.ltrim(FAILURE_QUEUE_KEY, 0, FAILURE_QUEUE_LIMIT - 1);
      } catch (queueError) {
        logger.error({
          eventType: event.type,
          errorName: queueError instanceof Error ? queueError.name : 'unknown',
        }, 'Could not record failed n8n event');
      }
    }
  });
}
