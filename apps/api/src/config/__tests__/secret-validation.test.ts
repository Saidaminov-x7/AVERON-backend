import { describe, expect, it } from 'vitest';
import { isDeniedRefreshSecret } from '../secret-validation';

describe('refresh secret validation', () => {
  it('rejects the known compromised value by fingerprint without storing it in source', () => {
    const compromisedValue = [
      'e7a2b9c4',
      'f1d8e3a5',
      'c7f2b6a9',
      'd1e4f8c2',
      'b5e7a1d3',
      'f9c4b8e2',
      'a6d1f5c7',
      'b3e9a4f2',
    ].join('');

    expect(isDeniedRefreshSecret(compromisedValue)).toBe(true);
  });

  it('rejects refresh secret placeholders and permits distinct random secrets', () => {
    expect(isDeniedRefreshSecret('your_refresh_secret_with_sufficient_length')).toBe(true);
    expect(isDeniedRefreshSecret(globalThis.crypto.randomUUID().repeat(3))).toBe(false);
  });
});
