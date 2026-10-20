import { describe, expect, it, vi } from 'vitest';
import { exportUserDataHandler } from '../export';

describe('personal data export security', () => {
  it('omits password, token, and TOTP secrets from the exported account record', async () => {
    const user = {
      id: 'user-1',
      email: 'buyer@example.test',
      name: 'Buyer',
      passwordHash: 'argon-hash-placeholder',
      refreshTokenHash: 'refresh-hash-placeholder',
      twoFactorSecret: 'totp-secret-placeholder',
      adminTotpSecret: 'admin-totp-secret-placeholder',
      wishlistShareToken: 'wishlist-share-token-placeholder',
      listings: [],
      favorites: [],
      savedSearches: [],
      viewingRequests: [],
      sentMessages: [],
      receivedMessages: [],
      reviewsWritten: [],
      reviewsReceived: [],
      userActivityLogs: [],
    };
    const findUnique = vi.fn(async () => user);
    const request = {
      user: { userId: user.id },
      server: { prisma: { user: { findUnique } } },
    } as never;
    const reply = {
      header: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };

    await exportUserDataHandler(request, reply as never);

    const exported = reply.send.mock.calls[0][0];
    expect(exported.user).not.toHaveProperty('passwordHash');
    expect(exported.user).not.toHaveProperty('refreshTokenHash');
    expect(exported.user).not.toHaveProperty('twoFactorSecret');
    expect(exported.user).not.toHaveProperty('adminTotpSecret');
    expect(exported.user).not.toHaveProperty('wishlistShareToken');
    expect(findUnique).toHaveBeenCalledOnce();
  });
});
