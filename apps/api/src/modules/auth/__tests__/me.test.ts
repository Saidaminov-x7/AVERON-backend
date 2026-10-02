import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { catalogCountryPreferenceSchema, updateCatalogCountryPreferenceHandler } from '../me';

function makeRequest(body: unknown, update = vi.fn()) {
  const request = {
    body,
    user: { userId: 'user-1' },
    server: { prisma: { user: { update } } },
  } as unknown as FastifyRequest;
  const reply = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  } as unknown as FastifyReply;
  return { request, reply, update };
}

describe('catalog country preference', () => {
  it.each(['CN', 'US', 'TR', 'IT', 'GB', null])('accepts supported country preference %s', (country) => {
    expect(catalogCountryPreferenceSchema.safeParse({ country }).success).toBe(true);
  });

  it('persists the authenticated user country preference', async () => {
    const update = vi.fn().mockResolvedValue({ defaultCatalogCountry: 'CN' });
    const { request, reply } = makeRequest({ country: 'CN' }, update);

    await updateCatalogCountryPreferenceHandler(request, reply);

    expect(update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { defaultCatalogCountry: 'CN' },
      select: { defaultCatalogCountry: true },
    });
    expect(reply.send).toHaveBeenCalledWith({ defaultCatalogCountry: 'CN' });
  });

  it('rejects unsupported country values without updating preferences', async () => {
    const update = vi.fn();
    const { request, reply } = makeRequest({ country: 'KZ' }, update);

    await updateCatalogCountryPreferenceHandler(request, reply);

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_CATALOG_COUNTRY' }));
    expect(update).not.toHaveBeenCalled();
  });
});
