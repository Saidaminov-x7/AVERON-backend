import { describe, expect, it } from 'vitest';
import { normalizeUzbekPhone, uzbekPhoneSchema } from '../phone';

describe('Uzbek phone normalization', () => {
  it.each([
    ['+998 90 123 45 67', '+998901234567'],
    ['90-123-45-67', '+998901234567'],
    ['998 (90) 123-45-67', '+998901234567'],
  ])('normalizes %s to the canonical E.164-like value', (input, expected) => {
    expect(normalizeUzbekPhone(input)).toBe(expected);
    expect(uzbekPhoneSchema.parse(input)).toBe(expected);
  });

  it.each(['+1 202 555 0147', '123', '+998 90 123 45 678', 'phone 901234567'])(
    'rejects invalid Uzbek phone input: %s',
    (input) => {
      expect(normalizeUzbekPhone(input)).toBeNull();
      expect(uzbekPhoneSchema.safeParse(input).success).toBe(false);
    },
  );
});
