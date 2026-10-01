import type { FastifyInstance } from 'fastify';
import type { AveronDomainEvent, DomainEventPublisher } from './contracts';

type DomainEventHandler = (event: AveronDomainEvent) => void | Promise<void>;

class InProcessDomainEventBus implements DomainEventPublisher {
  private readonly handlers = new Set<DomainEventHandler>();

  subscribe(handler: DomainEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async publish(event: AveronDomainEvent): Promise<void> {
    const results = await Promise.allSettled([...this.handlers].map((handler) => Promise.resolve().then(() => handler(event))));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      throw new AggregateError(failures.map((failure) => failure.reason), 'DOMAIN_EVENT_DELIVERY_FAILED');
    }
  }
}

export const domainEventBus = new InProcessDomainEventBus();

export function dispatchDomainEvent(app: FastifyInstance, event: AveronDomainEvent): void {
  void domainEventBus.publish(event).catch((error: unknown) => {
    app.log.error({
      eventType: event.type,
      failedHandlers: error instanceof AggregateError ? error.errors.length : 1,
    }, 'Internal domain event delivery failed');
  });
}
