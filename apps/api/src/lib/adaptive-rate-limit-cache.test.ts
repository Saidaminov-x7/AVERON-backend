import { describe, expect, it, vi } from 'vitest';
import { createAdaptiveRateLimitCache } from './adaptive-rate-limit-cache';

describe('createAdaptiveRateLimitCache', () => {
  it('caches a setting for 30 seconds by default and reloads after expiry', async () => {
    let currentTime = 1_000;
    const loadEnabled = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const getEnabled = createAdaptiveRateLimitCache(loadEnabled, vi.fn(), undefined, () => currentTime);

    await expect(getEnabled()).resolves.toBe(true);
    currentTime += 29_999;
    await expect(getEnabled()).resolves.toBe(true);
    expect(loadEnabled).toHaveBeenCalledTimes(1);

    currentTime += 1;
    await expect(getEnabled()).resolves.toBe(false);
    expect(loadEnabled).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent settings reads', async () => {
    let resolveLoad: ((value: boolean) => void) | undefined;
    const loadEnabled = vi.fn(() => new Promise<boolean>((resolve) => { resolveLoad = resolve; }));
    const getEnabled = createAdaptiveRateLimitCache(loadEnabled, vi.fn());

    const first = getEnabled();
    const second = getEnabled();
    expect(loadEnabled).toHaveBeenCalledTimes(1);
    resolveLoad?.(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it('logs a failed read and caches the configured-limit fallback briefly', async () => {
    const failure = new Error('database unavailable');
    const loadEnabled = vi.fn().mockRejectedValue(failure);
    const reportFailure = vi.fn();
    const getEnabled = createAdaptiveRateLimitCache(loadEnabled, reportFailure);

    await expect(getEnabled()).resolves.toBe(false);
    await expect(getEnabled()).resolves.toBe(false);
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(reportFailure).toHaveBeenCalledWith(failure);
    expect(loadEnabled).toHaveBeenCalledTimes(1);
  });
});
