import { describe, expect, it } from 'vitest';
import { isCoreApiReady } from '../health-readiness';

describe('core API readiness', () => {
  it('requires both database and Redis', () => {
    expect(isCoreApiReady(true, true)).toBe(true);
    expect(isCoreApiReady(false, true)).toBe(false);
    expect(isCoreApiReady(true, false)).toBe(false);
    expect(isCoreApiReady(false, false)).toBe(false);
  });
});
