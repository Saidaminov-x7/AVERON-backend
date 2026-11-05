import argon2 from 'argon2';
import { describe, expect, it, vi } from 'vitest';
import { AdminService } from './service';

function makeService(existingPassword: string | null = null) {
  let storedPassword = existingPassword;
  const siteSettings = {
    findUnique: vi.fn(async () => ({ maintenanceBypassPassword: storedPassword })),
    upsert: vi.fn(async ({ update, select }: {
      update: Record<string, unknown>;
      select: Record<string, unknown>;
    }) => {
      if (Object.prototype.hasOwnProperty.call(update, 'maintenanceBypassPassword')) {
        storedPassword = update.maintenanceBypassPassword as string | null;
      }
      return Object.fromEntries(Object.keys(select).flatMap((key) => (
        key === 'maintenanceBypassPassword' ? [[key, storedPassword]] : []
      )));
    }),
  };
  const auditCreate = vi.fn(async () => ({}));
  const service = new AdminService({
    siteSettings,
    auditLog: { create: auditCreate },
  } as never);
  return { service, siteSettings, auditCreate, getStoredPassword: () => storedPassword };
}

describe('admin maintenance password handling', () => {
  it('does not select the configured bypass password for the admin settings response', async () => {
    const { service, siteSettings } = makeService('$argon2id$stored-hash');

    await service.getSiteSettings();

    expect(siteSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.not.objectContaining({ maintenanceBypassPassword: true }),
    }));
  });

  it('hashes a newly configured password and excludes it from the audit record', async () => {
    const password = 'new-maintenance-access-password';
    const { service, auditCreate, getStoredPassword } = makeService();

    await service.updateSiteSettings({
      maintenancePasswordEnabled: true,
      maintenanceBypassPassword: password,
    }, 'admin-user');

    const stored = getStoredPassword();
    expect(stored).not.toBe(password);
    expect(stored).toMatch(/^\$argon2/);
    await expect(argon2.verify(stored!, password)).resolves.toBe(true);
    expect(JSON.stringify(auditCreate.mock.calls)).not.toContain(password);
  });

  it('clears the stored bypass password when the feature is disabled', async () => {
    const { service, getStoredPassword } = makeService('$argon2id$existing-hash');

    await service.updateSiteSettings({ maintenancePasswordEnabled: false }, 'admin-user');

    expect(getStoredPassword()).toBeNull();
  });

  it('refuses to enable password access without a configured password', async () => {
    const { service, siteSettings } = makeService();

    await expect(service.updateSiteSettings({ maintenancePasswordEnabled: true }, 'admin-user'))
      .rejects.toMatchObject({ statusCode: 400, message: 'MAINTENANCE_PASSWORD_REQUIRED' });
    expect(siteSettings.upsert).not.toHaveBeenCalled();
  });
});
