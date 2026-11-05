import argon2 from 'argon2';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { siteSettingsPublicModule } from '../index';

const PASSWORD = 'a-long-maintenance-password';
const apps: Array<ReturnType<typeof Fastify>> = [];

async function makeApp(settings: {
  maintenanceBypassPassword: string | null;
  maintenancePasswordEnabled: boolean;
}) {
  const findUnique = vi.fn(async () => settings);
  const updateMany = vi.fn(async (_args: {
    where: { id: string; maintenanceBypassPassword: string };
    data: { maintenanceBypassPassword: string };
  }) => ({ count: 1 }));
  const app = Fastify();
  apps.push(app);
  app.decorate('prisma', { siteSettings: { findUnique, updateMany } } as never);
  app.decorate('redis', { get: vi.fn(async () => null), set: vi.fn(async () => 'OK') } as never);
  await app.register(siteSettingsPublicModule, { prefix: '/site-settings' });
  await app.ready();
  return { app, findUnique, updateMany };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('maintenance bypass password verification', () => {
  it('rejects password checks when the feature is disabled', async () => {
    const { app } = await makeApp({ maintenanceBypassPassword: PASSWORD, maintenancePasswordEnabled: false });

    const response = await app.inject({ method: 'POST', url: '/site-settings/public/check-bypass', payload: { password: PASSWORD } });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ allowed: false });
  });

  it('verifies hashed passwords and rejects a wrong password', async () => {
    const hash = await argon2.hash(PASSWORD);
    const { app } = await makeApp({ maintenanceBypassPassword: hash, maintenancePasswordEnabled: true });

    const accepted = await app.inject({ method: 'POST', url: '/site-settings/public/check-bypass', payload: { password: PASSWORD } });
    const rejected = await app.inject({ method: 'POST', url: '/site-settings/public/check-bypass', payload: { password: 'wrong-password' } });

    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ allowed: true });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toMatchObject({ allowed: false });
  });

  it('upgrades a legacy plaintext password to Argon2 after successful verification', async () => {
    const { app, updateMany } = await makeApp({ maintenanceBypassPassword: PASSWORD, maintenancePasswordEnabled: true });

    const response = await app.inject({ method: 'POST', url: '/site-settings/public/check-bypass', payload: { password: PASSWORD } });

    expect(response.statusCode).toBe(200);
    expect(updateMany).toHaveBeenCalledOnce();
    const data = updateMany.mock.calls[0]?.[0].data as { maintenanceBypassPassword: string };
    expect(data.maintenanceBypassPassword).not.toBe(PASSWORD);
    expect(data.maintenanceBypassPassword).toMatch(/^\$argon2/);
    await expect(argon2.verify(data.maintenanceBypassPassword, PASSWORD)).resolves.toBe(true);
  });

  it('rejects malformed password values', async () => {
    const { app, findUnique } = await makeApp({ maintenanceBypassPassword: PASSWORD, maintenancePasswordEnabled: true });

    const response = await app.inject({ method: 'POST', url: '/site-settings/public/check-bypass', payload: { password: 42 } });

    expect(response.statusCode).toBe(400);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
