import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { describe, it } from 'vitest';
import { serializeSafeRequest } from './safe-request-logger';

describe('automatic request log privacy', () => {
  it('omits URL, headers, source address, and request data from serialized requests', () => {
    const serialized = serializeSafeRequest({
      method: 'GET',
      url: '/api/v1/orders?access_token=secret-query-token',
      headers: { authorization: 'Bearer secret-header-token', cookie: 'session=secret-cookie' },
      remoteAddress: '203.0.113.10',
      body: { password: 'secret-body-password' },
    } as { method: string });

    assert.deepEqual(serialized, { method: 'GET' });
    assert.equal(JSON.stringify(serialized).includes('secret'), false);
  });

  it('does not write query secrets when Fastify emits its automatic request logs', async () => {
    const output: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        output.push(chunk.toString());
        callback();
      },
    });
    const app = Fastify({
      logger: {
        level: 'info',
        stream,
        serializers: { req: (request) => serializeSafeRequest(request) },
      },
    });
    app.get('/api/v1/orders', async () => ({ ok: true }));

    try {
      const response = await app.inject('/api/v1/orders?access_token=secret-query-token');
      assert.equal(response.statusCode, 200);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const logs = output.join('');
      assert.match(logs, /"method":"GET"/);
      assert.equal(logs.includes('secret-query-token'), false);
      assert.equal(logs.includes('access_token'), false);
      assert.equal(logs.includes('203.0.113.10'), false);
    } finally {
      await app.close();
      stream.end();
    }
  });
});
