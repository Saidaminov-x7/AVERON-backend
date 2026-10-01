import { describe, expect, it } from 'vitest';
import { sanitizeErrorReportUrl, sanitizeErrorText } from '../sanitize';

describe('client error report sanitization', () => {
  it('removes credentials and URL query strings from free-form error data', () => {
    const safe = sanitizeErrorText(
      'GET https://averon.example/reset?token=secret Bearer abc.def api_key=key-value',
    );
    expect(safe).toBe('GET https://averon.example/reset Bearer [redacted] api_key=[redacted]');
    expect(safe).not.toContain('secret');
    expect(safe).not.toContain('key-value');
  });

  it('stores only the origin and path from an error report URL', () => {
    expect(sanitizeErrorReportUrl('https://averon.example/reset?token=secret#fragment'))
      .toBe('https://averon.example/reset');
    expect(sanitizeErrorReportUrl('/profile?email=user@example.com')).toBe('/profile');
    expect(sanitizeErrorReportUrl('javascript:alert(1)')).toBe('[invalid-url]');
  });
});
