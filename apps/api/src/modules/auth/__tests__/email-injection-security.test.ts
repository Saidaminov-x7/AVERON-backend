import { describe, expect, it, vi } from 'vitest';
import { config } from '../../../config';

vi.hoisted(() => {
  process.env.RESEND_API_KEY = '';
  process.env.TELEGRAM_BOT_TOKEN = '';
});

import { forgotPasswordHandler } from '../forgot-password';

describe('password reset email HTML security', () => {
  it('escapes an attacker-controlled stored account name before inserting it into HTML', async () => {
    const originalApiKey = config.RESEND_API_KEY;
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    Object.assign(config, { RESEND_API_KEY: 'test-only-provider-key' });

    const request = {
      body: { email: 'person@example.test', locale: 'en' },
      server: {
        prisma: {
          user: {
            findUnique: vi.fn(async () => ({
              id: 'test-user-id',
              email: 'person@example.test',
              name: '<img src=x onerror="alert(1)">',
              isBlocked: false,
            })),
          },
        },
        redis: { set: vi.fn(async () => 'OK') },
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as never;
    const reply = { send: vi.fn() } as never;

    try {
      await forgotPasswordHandler(request, reply);

      const requestOptions = fetchMock.mock.calls[0]?.[1];
      expect(requestOptions).toBeDefined();
      const email = JSON.parse(requestOptions!.body as string) as { html: string };
      expect(email.html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
      expect(email.html).not.toContain('<img src=x onerror=');
    } finally {
      Object.assign(config, { RESEND_API_KEY: originalApiKey });
      vi.unstubAllGlobals();
    }
  });
});
