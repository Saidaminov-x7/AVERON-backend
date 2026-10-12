import { describe, expect, it } from 'vitest';
import { safeHttpErrorMessage, toSafeErrorResponse } from './safe-error-response';

describe('toSafeErrorResponse', () => {
  it('preserves explicit client status codes without reflecting exception messages', () => {
    expect(toSafeErrorResponse(Object.assign(new Error('User not found'), { statusCode: 404 })))
      .toEqual({ statusCode: 404, message: 'Resource not found' });
    expect(toSafeErrorResponse(Object.assign(new Error('private account detail'), { statusCode: 403 })))
      .toEqual({ statusCode: 403, message: 'Access denied' });
  });

  it('uses stable messages for known HTTP failures', () => {
    expect(safeHttpErrorMessage(401)).toBe('Authentication required');
    expect(safeHttpErrorMessage(429)).toBe('Too many requests. Try again later.');
    expect(safeHttpErrorMessage(503)).toBe('An unexpected error occurred');
  });

  it('hides internal error details and normalizes the status to 500', () => {
    expect(toSafeErrorResponse(Object.assign(new Error('Prisma query leaked secret=abc'), { statusCode: 503 })))
      .toEqual({ statusCode: 503, message: 'An internal error occurred' });
  });

  it('does not expose messages from untyped or status-less errors', () => {
    expect(toSafeErrorResponse(new Error('database host and credentials')))
      .toEqual({ statusCode: 500, message: 'An internal error occurred' });
    expect(toSafeErrorResponse('raw failure detail'))
      .toEqual({ statusCode: 500, message: 'An internal error occurred' });
  });
});
