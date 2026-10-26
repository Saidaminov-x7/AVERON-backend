import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorReportsModule } from '../index';

describe('client error report privacy minimization', () => {
  const app = Fastify();

  afterEach(async () => {
    await app.close();
  });

  it('does not persist request IP or User-Agent for new reports', async () => {
    const createReport = vi.fn().mockResolvedValue({ id: 'error-report-1' });
    const createNotification = vi.fn().mockResolvedValue({ id: 'notification-1' });
    app.decorate('prisma', {
      clientErrorReport: { create: createReport },
      adminNotification: { create: createNotification },
    } as never);
    await app.register(errorReportsModule, { prefix: '/error-reports' });

    const response = await app.inject({
      method: 'POST',
      url: '/error-reports',
      remoteAddress: '198.51.100.44',
      headers: { 'user-agent': 'synthetic-test-agent' },
      payload: {
        message: 'Client-side application error',
        stack: '',
        url: '/ru/catalog',
        severity: 'error',
      },
    });

    expect(response.statusCode).toBe(201);
    const data = createReport.mock.calls[0]?.[0]?.data;
    expect(data).toMatchObject({
      message: 'Client-side application error',
      url: '/ru/catalog',
      severity: 'error',
    });
    expect(data).not.toHaveProperty('ip');
    expect(data).not.toHaveProperty('userAgent');
  });
});
