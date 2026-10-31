import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { safeHttpErrorMessage, toSafeErrorResponse } from './safe-error-response';

describe('toSafeErrorResponse', () => {
  it('preserves expected status codes but replaces exception messages with fixed text', () => {
    assert.deepEqual(toSafeErrorResponse(Object.assign(new Error('database password leaked'), { statusCode: 404 })), {
      statusCode: 404,
      message: 'Resource not found.',
    });
    assert.doesNotMatch(JSON.stringify(toSafeErrorResponse(new Error('private'))), /private/);
  });

  it('uses a fixed fallback for unknown and internal statuses', () => {
    assert.deepEqual(toSafeErrorResponse({ statusCode: 500, message: 'secret' }), {
      statusCode: 503,
      message: 'The service is temporarily unavailable. Please try again later.',
    });
  });

  it('uses stable non-sensitive messages for authorization, missing resources, and throttling', () => {
    assert.equal(safeHttpErrorMessage(401), 'Authentication is required.');
    assert.equal(safeHttpErrorMessage(403), 'Access denied.');
    assert.equal(safeHttpErrorMessage(404), 'Resource not found.');
    assert.equal(safeHttpErrorMessage(429), 'Too many requests. Try again later.');
    assert.equal(safeHttpErrorMessage(503), 'The service is temporarily unavailable. Please try again later.');
  });
});
