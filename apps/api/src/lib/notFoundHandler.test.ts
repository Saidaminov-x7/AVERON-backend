import assert from 'node:assert/strict';
import fastify from 'fastify';
import { describe, it } from 'vitest';
import { registerNotFoundHandler } from './notFoundHandler';

describe('registerNotFoundHandler', () => {
  it('returns a fixed 404 without reflecting paths, query values, or methods', async () => {
    const app = fastify();
    registerNotFoundHandler(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/private-user-secret?token=must-not-reflect',
    });

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), {
      statusCode: 404,
      error: 'Not Found',
      message: 'Route not found',
    });
    assert.doesNotMatch(response.body, /private-user-secret|must-not-reflect|GET/);
    await app.close();
  });

  it('uses a generic 429 when a temporary source restriction is active', async () => {
    const app = fastify();
    registerNotFoundHandler(app, async () => true);
    const response = await app.inject({ method: 'GET', url: '/admin/users?all=1' });
    assert.equal(response.statusCode, 429);
    assert.deepEqual(response.json(), {
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Too many requests. Try again later.',
    });
    await app.close();
  });
});
