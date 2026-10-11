import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerNotFoundHandler } from './notFoundHandler';

describe('registerNotFoundHandler', () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('returns a generic 404 without reflecting unknown paths or query secrets', async () => {
    const app = Fastify();
    apps.push(app);
    registerNotFoundHandler(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/private-probe?token=do-not-reflect&email=person%40example.com',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Route not found',
    });
    expect(response.body).not.toContain('private-probe');
    expect(response.body).not.toContain('do-not-reflect');
    expect(response.body).not.toContain('person@example.com');
  });
});
