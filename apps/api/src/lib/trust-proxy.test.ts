import assert from 'node:assert/strict';
import fastify from 'fastify';
import { describe, it } from 'vitest';
import { trustProxyOption } from './trust-proxy';

describe('trustProxyOption', () => {
  it('does not trust forwarded headers unless proxy addresses are explicitly configured', async () => {
    const app = fastify({ trustProxy: trustProxyOption([]) });
    app.get('/ip', async (request) => ({ ip: request.ip, ips: request.ips }));

    const response = await app.inject({
      method: 'GET',
      url: '/ip',
      headers: {
        'x-forwarded-for': '198.51.100.11',
        forwarded: 'for=203.0.113.12',
        'x-real-ip': '192.0.2.13',
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ip, '127.0.0.1');
    await app.close();
  });

  it.each([
    '198.51.100.11, 10.0.0.1',
    '2001:db8::11, 10.0.0.1',
  ])('ignores spoofed and multi-hop X-Forwarded-For when trust is empty: %s', async (forwardedFor) => {
    const app = fastify({ trustProxy: trustProxyOption([]) });
    app.get('/ip', async (request) => ({ ip: request.ip }));

    const response = await app.inject({
      method: 'GET',
      url: '/ip',
      headers: { 'x-forwarded-for': forwardedFor },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ip, '127.0.0.1');
    await app.close();
  });

  it('trusts only the explicitly configured proxy addresses', () => {
    assert.deepEqual(trustProxyOption(['10.0.0.1', '192.0.2.0/24']), ['10.0.0.1', '192.0.2.0/24']);
    assert.equal(trustProxyOption([]), false);
  });

  it('does not trust forwarded protocol headers without explicit proxy addresses', async () => {
    const app = fastify({ trustProxy: trustProxyOption([]) });
    app.get('/protocol', async (request) => ({ protocol: request.protocol }));

    const response = await app.inject({
      method: 'GET',
      url: '/protocol',
      headers: { 'x-forwarded-proto': 'https' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().protocol, 'http');
    await app.close();
  });
});
