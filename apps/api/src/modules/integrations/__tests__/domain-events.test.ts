import { describe, expect, it, vi } from 'vitest';
import { domainEventBus } from '../domain-events';

describe('internal domain event bus', () => {
  it('delivers provider-neutral events to subscribers without requiring an external service', async () => {
    const handler = vi.fn();
    const unsubscribe = domainEventBus.subscribe(handler);
    const event = {
      type: 'product.import.received' as const,
      importId: 'import-1',
      provider: 'SOURCE_1688',
      occurredAt: '2026-10-01T08:00:00.000Z',
    };

    await domainEventBus.publish(event);

    expect(handler).toHaveBeenCalledWith(event);
    unsubscribe();
  });

  it('isolates delivery failures by rejecting only the non-blocking dispatcher operation', async () => {
    const unsubscribe = domainEventBus.subscribe(() => { throw new Error('listener failed'); });
    const delivery = domainEventBus.publish({
      type: 'product.import.rejected',
      importId: 'import-1',
      actorId: 'admin-1',
      occurredAt: '2026-10-01T08:00:00.000Z',
    });
    await expect(delivery).rejects.toMatchObject({ message: 'DOMAIN_EVENT_DELIVERY_FAILED' });
    unsubscribe();
  });
});
