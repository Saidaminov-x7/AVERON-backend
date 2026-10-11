import { describe, expect, it } from 'vitest';
import { toSafeErrorResponse } from './safe-error-response';

describe('toSafeErrorResponse', () => {
  it('preserves explicit client errors with their intended status', () => {
    expect(toSafeErrorResponse(Object.assign(new Error('User not found'), { statusCode: 404 })))
      .toEqual({ statusCode: 404, message: 'User not found' });
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
