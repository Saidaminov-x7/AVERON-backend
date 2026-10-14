import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdleConnectionManager } from './idle-connection-manager';

describe('createIdleConnectionManager', () => {
  afterEach(() => vi.useRealTimers());

  it('disconnects only after all requests finish and the idle grace period elapses', async () => {
    vi.useFakeTimers();
    const connect = vi.fn().mockResolvedValue(undefined);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const manager = createIdleConnectionManager({ idleMs: 1_000, connect, disconnect });

    await Promise.all([manager.acquire(), manager.acquire()]);
    manager.release();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(disconnect).not.toHaveBeenCalled();

    manager.release();
    await vi.advanceTimersByTimeAsync(999);
    expect(disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('reconnects after an idle disconnect before serving a new request', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const manager = createIdleConnectionManager({
      idleMs: 1_000,
      connect: async () => { events.push('connect'); },
      disconnect: async () => { events.push('disconnect'); },
    });

    await manager.acquire();
    manager.release();
    await vi.advanceTimersByTimeAsync(1_000);
    await manager.acquire();

    expect(events).toEqual(['connect', 'disconnect', 'connect']);
    manager.release();
  });

  it('does not start a second connection when requests arrive together', async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const manager = createIdleConnectionManager({ idleMs: 1_000, connect, disconnect: vi.fn() });

    await Promise.all([manager.acquire(), manager.acquire(), manager.acquire()]);
    expect(connect).toHaveBeenCalledOnce();
    manager.release();
    manager.release();
    manager.release();
  });
});
