import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createParserImportModule } from '../parser-import';

const token = 'unit-test-parser-import-token-0123456789';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    provider: 'SOURCE_1688',
    sourceProductId: '1688-item-1',
    deduplicationKey: 'SOURCE_1688:1688-item-1',
    sourceUrl: 'https://detail.1688.com/offer/123.html',
    sourceTitle: 'Cotton jacket',
    sourceImages: ['https://img.example/jacket.jpg'],
    country: 'CN',
    sourceAttributes: { material: 'cotton' },
    variants: [],
    sizes: [],
    fetchedAt: '2026-10-01T08:00:00.000Z',
    ...overrides,
  };
}

function createApp({
  enabled = true,
  existing = null as Record<string, unknown> | null,
}: { enabled?: boolean; existing?: Record<string, unknown> | null } = {}) {
  let record = existing;
  const importedProduct = {
    findUnique: vi.fn(async () => record),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      record = { id: 'import-1', ...data };
      return record;
    }),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      record = { ...record, ...data };
      return record;
    }),
    updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      record = { ...record, ...data };
      return { count: 1 };
    }),
    findUniqueOrThrow: vi.fn(async () => record),
  };
  const app = Fastify();
  app.decorate('prisma', { importedProduct } as never);
  app.register(createParserImportModule({
    getToken: () => token,
    isProviderEnabled: () => enabled,
  }), { prefix: '/api/v1' });
  return { app, importedProduct, getRecord: () => record };
}

const authHeaders = { authorization: `Bearer ${token}` };

describe('authenticated Parser import API', () => {
  it('requires the service token without disclosing parser credentials', async () => {
    const { app } = createApp();
    await app.ready();
    const response = await app.inject({ method: 'POST', url: '/api/v1/parser/imports', payload: payload() });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(response.body).not.toContain(token);
    await app.close();
  });

  it('rejects unsupported contract versions and disabled providers', async () => {
    const versionApp = createApp();
    await versionApp.app.ready();
    const versionResponse = await versionApp.app.inject({
      method: 'POST',
      url: '/api/v1/parser/imports',
      headers: authHeaders,
      payload: payload({ schemaVersion: 2 }),
    });
    expect(versionResponse.statusCode).toBe(422);
    expect(versionResponse.json().code).toBe('UNSUPPORTED_SCHEMA_VERSION');
    await versionApp.app.close();

    const disabledApp = createApp({ enabled: false });
    await disabledApp.app.ready();
    const disabledResponse = await disabledApp.app.inject({
      method: 'POST',
      url: '/api/v1/parser/imports',
      headers: authHeaders,
      payload: payload(),
    });
    expect(disabledResponse.statusCode).toBe(403);
    expect(disabledResponse.json().code).toBe('FEATURE_DISABLED');
    await disabledApp.app.close();
  });

  it('creates a bounded PENDING_REVIEW snapshot and accepts missing source price', async () => {
    const { app, importedProduct, getRecord } = createApp();
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/parser/imports',
      headers: authHeaders,
      payload: payload(),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().result).toBe('CREATED');
    expect(importedProduct.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'PENDING_REVIEW',
        sourcePriceCny: null,
        normalizedPayload: expect.objectContaining({
          country: 'CN',
          sourceImages: ['https://img.example/jacket.jpg'],
          schemaVersion: 1,
        }),
      }),
    }));
    expect(getRecord()).toMatchObject({ status: 'PENDING_REVIEW' });
    await app.close();
  });

  it('returns stable idempotent results and never overwrites reviewed imports', async () => {
    const { app, importedProduct } = createApp({
      existing: {
        id: 'import-1',
        status: 'REJECTED',
        sourceMetadata: { payloadHash: 'old' },
      },
    });
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/parser/imports',
      headers: authHeaders,
      payload: payload(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result).toBe('ALREADY_EXISTS');
    expect(importedProduct.update).not.toHaveBeenCalled();
    await app.close();

    const pendingApp = createApp({
      existing: {
        id: 'import-1',
        status: 'PENDING_REVIEW',
        sourceMetadata: {},
      },
    });
    await pendingApp.app.ready();
    const repeated = await pendingApp.app.inject({
      method: 'POST',
      url: '/api/v1/parser/imports',
      headers: authHeaders,
      payload: payload(),
    });
    expect(repeated.json().result).toBe('UPDATED_PENDING');
    await pendingApp.app.close();
  });

  it('rejects unreasonable image counts and unavailable providers', async () => {
    const { app } = createApp();
    await app.ready();
    const invalidResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/parser/imports',
      headers: authHeaders,
      payload: payload({ sourceImages: Array.from({ length: 16 }, (_, i) => `https://img.example/${i}.jpg`) }),
    });
    expect(invalidResponse.statusCode).toBe(400);
    expect(invalidResponse.json().code).toBe('INVALID_IMPORT_PAYLOAD');

    const unavailableResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/parser/imports',
      headers: authHeaders,
      payload: payload({
        provider: 'PINDUODUO',
        sourceProductId: 'pdd-1',
        deduplicationKey: 'PINDUODUO:pdd-1',
        sourceUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=123',
      }),
    });
    expect(unavailableResponse.statusCode).toBe(503);
    expect(unavailableResponse.json().code).toBe('PROVIDER_UNAVAILABLE');
    await app.close();
  });
});
