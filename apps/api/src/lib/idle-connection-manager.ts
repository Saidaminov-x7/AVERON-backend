export type IdleConnectionManager = {
  acquire(): Promise<void>;
  release(): void;
  scheduleClose(): void;
  close(): Promise<void>;
};

type IdleConnectionManagerOptions = {
  idleMs: number;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onError?(error: unknown): void;
};

/** Closes network clients after quiet periods and reconnects before the next request. */
export function createIdleConnectionManager({
  idleMs,
  connect,
  disconnect,
  onError,
}: IdleConnectionManagerOptions): IdleConnectionManager {
  let activeRequests = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connecting: Promise<void> | undefined;
  let closing: Promise<void> | undefined;

  const clearIdleTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const closeWhenIdle = () => {
    clearIdleTimer();
    if (activeRequests !== 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (activeRequests !== 0 || closing) return;
      const pending = disconnect()
        .catch((error: unknown) => onError?.(error))
        .finally(() => {
          if (closing === pending) closing = undefined;
        });
      closing = pending;
    }, idleMs);
    timer.unref?.();
  };

  const ensureConnected = () => {
    if (connecting) return connecting;
    const pending = (async () => {
      if (closing) await closing;
      await connect();
    })().finally(() => {
      if (connecting === pending) connecting = undefined;
    });
    connecting = pending;
    return pending;
  };

  return {
    async acquire() {
      clearIdleTimer();
      activeRequests += 1;
      try {
        await ensureConnected();
      } catch (error) {
        activeRequests = Math.max(0, activeRequests - 1);
        if (activeRequests === 0) closeWhenIdle();
        throw error;
      }
    },
    release() {
      activeRequests = Math.max(0, activeRequests - 1);
      if (activeRequests === 0) closeWhenIdle();
    },
    scheduleClose() {
      if (activeRequests === 0) closeWhenIdle();
    },
    async close() {
      clearIdleTimer();
      if (activeRequests !== 0) return;
      if (closing) await closing;
      else await disconnect();
    },
  };
}
