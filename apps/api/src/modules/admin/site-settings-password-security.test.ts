import argon2 from 'argon2';
import { describe, expect, it, vi } from 'vitest';
import { AdminService } from './service';

describe('admin maintenance password settings', () => {
  it('returns a configured flag without returning the stored password or hash', async () => {
    const passwordHash = await argon2.hash('maintenance-password');
    const prisma = {
      siteSettings: {
        upsert: vi.fn(async () => ({
          id: 'singleton',
          maintenanceBypassPassword: passwordHash,
          maintenancePasswordEnabled: true,
        })),
      },
    };
    const service = new AdminService(prisma as never);

    const settings = await service.getSiteSettings();

    expect(settings).toMatchObject({ id: 'singleton', maintenanceBypassPasswordConfigured: true });
    expect(settings).not.toHaveProperty('maintenanceBypassPassword');
    expect(JSON.stringify(settings)).not.toContain(passwordHash);
  });

  it('hashes a new bypass password and excludes it from the audit log', async () => {
    const clearPassword = 'NewMaintenancePassword123';
    const upsert = vi.fn(async (args: { update: { maintenanceBypassPassword?: string } }) => ({
      id: 'singleton',
      maintenanceBypassPassword: args.update.maintenanceBypassPassword,
      maintenancePasswordEnabled: true,
    }));
    const auditCreate = vi.fn(async () => ({}));
    const prisma = {
      siteSettings: { upsert },
      auditLog: { create: auditCreate },
    };
    const service = new AdminService(prisma as never);

    const settings = await service.updateSiteSettings({ maintenanceBypassPassword: clearPassword }, 'admin-id');

    const storedHash = upsert.mock.calls[0][0].update.maintenanceBypassPassword;
    expect(storedHash).toMatch(/^\$argon2/);
    expect(await argon2.verify(storedHash!, clearPassword)).toBe(true);
    expect(JSON.stringify(settings)).not.toContain(clearPassword);
    expect(settings).not.toHaveProperty('maintenanceBypassPassword');
    expect(JSON.stringify(settings)).not.toContain(storedHash);
    expect(JSON.stringify(auditCreate.mock.calls)).not.toContain(clearPassword);
  });
});
