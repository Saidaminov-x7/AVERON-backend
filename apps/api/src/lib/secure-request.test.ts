import { describe, expect, it } from 'vitest';
import { isSecureRequest } from './secure-request';

describe('isSecureRequest', () => {
  it('accepts a direct HTTPS connection', () => {
    expect(isSecureRequest('https', undefined)).toBe(true);
  });

  it('accepts Railway edge HTTPS when Fastify sees the internal HTTP hop', () => {
    expect(isSecureRequest('http', 'https', 'railway-environment')).toBe(true);
  });

  it('does not trust forwarded HTTPS outside Railway', () => {
    expect(isSecureRequest('http', 'https')).toBe(false);
  });

  it('rejects an HTTP request forwarded by Railway', () => {
    expect(isSecureRequest('http', 'http', 'railway-environment')).toBe(false);
  });
});
