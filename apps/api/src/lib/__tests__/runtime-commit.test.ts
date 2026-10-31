import { describe, expect, it } from 'vitest';
import { getRuntimeCommitSha } from '../runtime-commit';

describe('runtime commit identity', () => {
  it('exposes only a complete git SHA and normalizes its case', () => {
    const sha = 'A'.repeat(40);
    expect(getRuntimeCommitSha(sha)).toBe('a'.repeat(40));
    expect(getRuntimeCommitSha('a'.repeat(39))).toBeNull();
    expect(getRuntimeCommitSha('not-a-sha')).toBeNull();
    expect(getRuntimeCommitSha(undefined)).toBeNull();
  });
});
