type CacheEntry = {
  enabled: boolean;
  expiresAt: number;
};

export function createAdaptiveRateLimitCache(
  loadEnabled: () => Promise<boolean>,
  reportFailure: (error: unknown) => void,
  ttlMs = 30_000,
  now: () => number = Date.now,
): () => Promise<boolean> {
  let cached: CacheEntry | undefined;
  let inFlight: Promise<boolean> | undefined;

  return async () => {
    if (cached && cached.expiresAt > now()) return cached.enabled;
    if (inFlight) return inFlight;

    const pending = loadEnabled()
      .catch((error: unknown) => {
        reportFailure(error);
        return false;
      })
      .then((enabled) => {
        cached = { enabled, expiresAt: now() + ttlMs };
        return enabled;
      })
      .finally(() => {
        if (inFlight === pending) inFlight = undefined;
      });
    inFlight = pending;
    return pending;
  };
}
