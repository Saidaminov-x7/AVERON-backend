import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createTrustedCookieOriginGuard } from './trusted-cookie-origin';

describe('cookie-authenticated route origin guard', () => {
  it.each(['/auth/refresh', '/auth/logout'])('rejects missing and hostile origins for %s', async (url) => {
    const app = Fastify();
    app.post(url, { preHandler: createTrustedCookieOriginGuard(new Set(['https://averon.uz'])) }, async () => ({ ok: true }));
    await app.ready();
    const missing = await app.inject({ method: 'POST', url });
    const hostile = await app.inject({ method: 'POST', url, headers: { origin: 'https://attacker.example' } });
    const allowed = await app.inject({ method: 'POST', url, headers: { origin: 'https://averon.uz' } });
    expect(missing.statusCode).toBe(403);
    expect(hostile.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });
});
