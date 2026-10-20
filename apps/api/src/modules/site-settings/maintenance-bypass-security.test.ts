import Fastify from 'fastify';
import argon2 from 'argon2';
import { describe, expect, it, vi } from 'vitest';
import { siteSettingsPublicModule } from './index';

function createApp(settings: { maintenanceBypassPassword: string | null }) {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const findUnique = vi.fn(async () => ({
    siteName: 'AVERON',
    contactEmail: '',
    contactPhone: '',
    maintenanceMode: false,
    maintenanceMessage: null,
    maintenancePasswordEnabled: false,
    googleAuthEnabled: true,
    autoModerationEnabled: false,
    logoUrl: null,
    navLinks: null,
    mobilePinchZoomEnabled: true,
    ...settings,
  }));
  const cachedSettings = vi.fn(async () => null as string | null);
  const app = Fastify();
  app.decorate('redis', { get: cachedSettings, set: vi.fn(async () => 'OK') } as never);
  app.decorate('prisma', {
    siteSettings: { findUnique, updateMany },
    themeSettings: { findUnique: vi.fn(async () => null) },
  } as never);
  app.register(siteSettingsPublicModule);
  return { app, findUnique, updateMany, cachedSettings };
}

describe('maintenance bypass password storage', () => {
  it('upgrades a valid legacy plaintext password to Argon2 only after successful verification', async () => {
    const legacyPassword = 'existing-maintenance-password';
    const { app, updateMany } = createApp({ maintenanceBypassPassword: legacyPassword });
    try {
      const rejected = await app.inject({ method: 'POST', url: '/public/check-bypass', payload: { password: 'wrong-password' } });
      expect(rejected.statusCode).toBe(401);
      expect(updateMany).not.toHaveBeenCalled();

      const accepted = await app.inject({ method: 'POST', url: '/public/check-bypass', payload: { password: legacyPassword } });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toEqual({ allowed: true });
      const storedHash = (updateMany.mock.calls[0] as unknown as [{ data: { maintenanceBypassPassword: string } }])[0].data.maintenanceBypassPassword;
      expect(storedHash).toMatch(/^\$argon2/);
      expect(await argon2.verify(storedHash, legacyPassword)).toBe(true);
      expect(JSON.stringify(accepted.json())).not.toContain(legacyPassword);
    } finally {
      await app.close();
    }
  });

  it('returns only a configured flag from the public settings response', async () => {
    const { app } = createApp({ maintenanceBypassPassword: '$argon2id$existing-hash' });
    try {
      const response = await app.inject('/public');
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toContain('maintenanceBypassPassword');
      expect(response.body).not.toContain('argon2id');
    } finally {
      await app.close();
    }
  });

  it('removes a legacy password from previously cached public settings', async () => {
    const legacyPassword = 'cached-legacy-maintenance-password';
    const cachedSettings = JSON.stringify({ siteName: 'AVERON', maintenanceBypassPassword: legacyPassword });
    const { app, cachedSettings: getCachedSettings } = createApp({ maintenanceBypassPassword: null });
    getCachedSettings.mockResolvedValue(cachedSettings);
    try {
      const response = await app.inject('/public');
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(legacyPassword);
      expect(response.body).not.toContain('maintenanceBypassPassword');
    } finally {
      await app.close();
    }
  });
});
