import Fastify from 'fastify';
import { fastifyMultipart } from '@fastify/multipart';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/adminMiddleware', () => ({
  adminMiddleware: async (request: object) => {
    Object.assign(request, {
      user: { userId: '00000000-0000-4000-8000-000000000001', role: 'ADMIN', adminRole: 'SUPER_ADMIN' },
    });
  },
  requireAdminRole: () => async (request: object) => {
    Object.assign(request, {
      user: { userId: '00000000-0000-4000-8000-000000000001', role: 'ADMIN', adminRole: 'SUPER_ADMIN' },
    });
  },
}));

import { featureFlags } from '../../features/feature-flags';
import { createFittingRoomModule } from '../fitting-room';

const productId = '00000000-0000-4000-8000-000000000010';
const assetId = '00000000-0000-4000-8000-000000000020';
const jobId = '00000000-0000-4000-8000-000000000030';
const imageId = '00000000-0000-4000-8000-000000000040';
const userId = '00000000-0000-4000-8000-000000000001';

function makeValidGlb() {
  const document = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [0, 0, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const json = Buffer.from(JSON.stringify(document));
  const paddedJson = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + paddedJson.length + 8 + 36, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(paddedJson.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(36, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, paddedJson, binaryHeader, Buffer.alloc(36)]);
}

function multipartGlb(data: Buffer, fieldName = 'file') {
  const boundary = 'averon-glb-test-boundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="fixture.glb"\r\nContent-Type: model/gltf-binary\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function createTestApp(status: 'NEEDS_REVIEW' | 'APPROVED' = 'NEEDS_REVIEW') {
  const job = {
    id: jobId, productId, variantId: null, initiatedById: userId, idempotencyKey: 'fixture-key-0001',
    requestHash: null, sourceImageIds: [], garmentLayer: 'BASE_TOP', status: 'QUEUED', stage: 'QUEUED',
    attemptCount: 0, maxAttempts: 3, nextAttemptAt: new Date(), workerId: null, leaseToken: null,
    leaseExpiresAt: null, cancelRequestedAt: null, errorCode: null, errorMessage: null,
    resultAssetId: null, createdAt: new Date(), startedAt: null, completedAt: null, updatedAt: new Date(),
  };
  const asset = {
    id: assetId,
    revision: 0,
    productId,
    status,
    garmentLayer: 'BASE_TOP',
    variantId: null,
    fileKey: 'private/fixture.glb',
    fileSize: 1024,
    mannequinVersion: 'averon-neutral-v1',
    positionX: 0,
    positionY: 0.8,
    positionZ: 0,
    scale: 1,
    rejectionReason: null,
  };
  const applyAssetUpdate = (data: Record<string, unknown>) => {
    const { revision, ...fields } = data;
    Object.assign(asset, fields);
    if (revision && typeof revision === 'object' && 'increment' in revision) {
      asset.revision += Number((revision as { increment: number }).increment);
    }
  };
  const tx = {
    product3DGenerationJob: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(job, data, { id: jobId })),
      findFirst: vi.fn(async () => ({ id: jobId })),
      findUnique: vi.fn(async () => ({ ...job })),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (where.status && where.status !== job.status) return { count: 0 };
        Object.assign(job, data);
        return { count: 1 };
      }),
    },
    product3DAsset: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: assetId, ...data })),
      findUnique: vi.fn(async () => ({ ...asset })),
      updateMany: vi.fn(async ({ where, data }: { where: { revision: number; status?: string }; data: Record<string, unknown> }) => {
        if (where.revision !== asset.revision || (where.status && where.status !== asset.status)) return { count: 0 };
        applyAssetUpdate(data);
        return { count: 1 };
      }),
      deleteMany: vi.fn(async ({ where }: { where: { revision: number } }) => {
        if (where.revision !== asset.revision) return { count: 0 };
        return { count: 1 };
      }),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  const prisma = {
    commerceProduct: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => ({ id: productId })),
    },
    commerceProductVariant: { findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })) },
    commerceProductImage: { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id }))) },
    product3DGenerationJob: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if ('initiatedById_idempotencyKey' in where) return job.requestHash ? { ...job } : null;
        return where.id === job.id ? { ...job } : null;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => where.status === 'QUEUED' && job.status === 'QUEUED' ? { id: jobId } : null),
      findMany: vi.fn(async () => [{ ...job }]),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(job, data, { id: jobId })),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (where.status && where.status !== job.status) return { count: 0 };
        if ('id' in where && where.id !== job.id) return { count: 0 };
        Object.assign(job, data);
        return { count: 1 };
      }),
    },
    product3DAsset: {
      findUnique: vi.fn(async () => ({ ...asset, productId })),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const storage = {
    upload: vi.fn(async (_data: Buffer, hash: string) => `private/${hash}.glb`),
    signedUrl: vi.fn((key: string) => `https://cdn.example.test/signed/${key}`),
    delete: vi.fn(),
  };
  const app = Fastify();
  app.decorate('prisma', prisma as never);
  return { app, prisma, tx, storage, asset, job };
}

async function start(app: ReturnType<typeof Fastify>, storage: ReturnType<typeof createTestApp>['storage']) {
  await app.register(fastifyMultipart);
  await app.register(createFittingRoomModule(() => storage), { prefix: '/api/v1' });
  await app.ready();
}

describe('fitting-room routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv('LOCAL_3D_GENERATOR_MODULE', resolve('local-3d-generator.test.mjs'));
    vi.spyOn(featureFlags, 'isEnabled').mockReturnValue(true);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('validates, stores privately, and creates a review-pending asset from a real multipart GLB request', async () => {
    const { app, tx, storage } = createTestApp();
    await start(app, storage);
    const form = multipartGlb(makeValidGlb());

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/products/${productId}/fitting-room/assets?layer=BASE_TOP`,
      headers: { 'content-type': form.contentType },
      payload: form.body,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: assetId, status: 'NEEDS_REVIEW', garmentLayer: 'BASE_TOP' });
    expect(storage.upload).toHaveBeenCalledOnce();
    expect(storage.upload.mock.calls[0][0]).toEqual(makeValidGlb());
    expect(tx.product3DAsset.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      productId,
      fileKey: expect.stringMatching(/^private\/[a-f0-9]{64}\.glb$/),
      status: 'NEEDS_REVIEW',
      source: 'MANUAL',
      garmentLayer: 'BASE_TOP',
    }) });
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    expect(response.json().previewUrl).toContain('/signed/private/');
    await app.close();
  });

  it('rejects malformed GLB bytes before storage or database writes', async () => {
    const { app, tx, storage } = createTestApp();
    await start(app, storage);
    const malformed = Buffer.from('not a glb');
    const form = multipartGlb(malformed);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/products/${productId}/fitting-room/assets?layer=BASE_TOP`,
      headers: { 'content-type': form.contentType },
      payload: form.body,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'GLB_SIZE_INVALID' });
    expect(storage.upload).not.toHaveBeenCalled();
    expect(tx.product3DAsset.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns a storage error without writing an asset when private upload fails', async () => {
    const { app, prisma, tx, storage } = createTestApp();
    storage.upload.mockRejectedValue(new Error('fixture storage unavailable'));
    await start(app, storage);
    const form = multipartGlb(makeValidGlb());

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/products/${productId}/fitting-room/assets?layer=BASE_TOP`,
      headers: { 'content-type': form.contentType },
      payload: form.body,
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ code: 'FITTING_ROOM_STORAGE_UNAVAILABLE' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.product3DAsset.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('removes a privately uploaded orphan if the database transaction fails', async () => {
    const { app, prisma, tx, storage } = createTestApp();
    prisma.$transaction.mockRejectedValue(new Error('fixture database unavailable'));
    await start(app, storage);
    const form = multipartGlb(makeValidGlb());

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/products/${productId}/fitting-room/assets?layer=BASE_TOP`,
      headers: { 'content-type': form.contentType },
      payload: form.body,
    });

    expect(response.statusCode).toBe(500);
    expect(storage.delete).toHaveBeenCalledOnce();
    expect(storage.delete).toHaveBeenCalledWith(expect.stringMatching(/^private\/[a-f0-9]{64}\.glb$/));
    expect(tx.product3DAsset.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('keeps public model access disabled when the feature flag is off', async () => {
    vi.mocked(featureFlags.isEnabled).mockReturnValue(false);
    const { app, prisma, storage } = createTestApp();
    await start(app, storage);

    const response = await app.inject({ method: 'GET', url: `/api/v1/products/${productId}/fitting-room` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: 'FEATURE_DISABLED' });
    expect(prisma.commerceProduct.findFirst).not.toHaveBeenCalled();
    expect(storage.signedUrl).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not expose a product without an approved fitting-room model', async () => {
    const { app, prisma, storage } = createTestApp();
    await start(app, storage);

    const response = await app.inject({ method: 'GET', url: `/api/v1/products/${productId}/fitting-room` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: 'FITTING_ROOM_MODEL_UNAVAILABLE' });
    expect(prisma.commerceProduct.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [{ id: productId }, { slug: productId }, { publicId: productId }],
        status: 'PUBLISHED',
      }),
    }));
    expect(prisma.commerceProduct.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        fittingRoomAssets: expect.objectContaining({ where: { status: 'APPROVED' } }),
      }),
    }));
    expect(storage.signedUrl).not.toHaveBeenCalled();
    await app.close();
  });

  it('requires a reason for rejection and stores the review plus audit entry atomically', async () => {
    const { app, tx, storage, asset } = createTestApp();
    await start(app, storage);

    const missingReason = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fitting-room/assets/${assetId}/review`,
      payload: { action: 'reject' },
    });
    expect(missingReason.statusCode).toBe(400);
    expect(tx.product3DAsset.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();

    const rejection = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fitting-room/assets/${assetId}/review`,
      payload: { action: 'reject', rejectionReason: 'Fixture geometry is misaligned.' },
    });
    expect(rejection.statusCode).toBe(200);
    expect(rejection.json()).toMatchObject({ status: 'REJECTED', rejectionReason: 'Fixture geometry is misaligned.' });
    expect(tx.product3DAsset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: assetId, status: 'NEEDS_REVIEW', revision: 0 },
      data: expect.objectContaining({ status: 'REJECTED', reviewedById: userId, rejectionReason: 'Fixture geometry is misaligned.' }),
    }));
    expect(asset.revision).toBe(1);
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId,
        action: 'PRODUCT_3D_ASSET_REJECTED',
        resourceId: assetId,
        meta: expect.objectContaining({ previousStatus: 'NEEDS_REVIEW', status: 'REJECTED', rejectionReason: 'Fixture geometry is misaligned.' }),
      }),
    }));
    expect(app.prisma.$transaction).toHaveBeenCalledOnce();
    await app.close();
  });

  it('approves a reviewed model and records the reviewer in the audit log', async () => {
    const { app, tx, storage, asset } = createTestApp();
    await start(app, storage);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fitting-room/assets/${assetId}/review`,
      payload: { action: 'approve' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'APPROVED', rejectionReason: null });
    expect(tx.product3DAsset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: assetId, status: 'NEEDS_REVIEW', revision: 0 },
      data: expect.objectContaining({ status: 'APPROVED', reviewedById: userId, rejectionReason: null }),
    }));
    expect(asset.revision).toBe(1);
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId, action: 'PRODUCT_3D_ASSET_APPROVED', resourceId: assetId }),
    }));
    await app.close();
  });

  it('returns an edited approved model to review and audits the changed public metadata atomically', async () => {
    const { app, tx, storage, asset } = createTestApp('APPROVED');
    await start(app, storage);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/fitting-room/assets/${assetId}`,
      payload: { garmentLayer: 'OUTERWEAR', scale: 1.2 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'NEEDS_REVIEW', garmentLayer: 'OUTERWEAR', scale: 1.2 });
    expect(tx.product3DAsset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: assetId, revision: 0 },
      data: expect.objectContaining({
        garmentLayer: 'OUTERWEAR',
        scale: 1.2,
        status: 'NEEDS_REVIEW',
        reviewedById: null,
        approvedAt: null,
        rejectionReason: null,
      }),
    }));
    expect(asset.revision).toBe(1);
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId,
        action: 'PRODUCT_3D_ASSET_UPDATED',
        resourceId: assetId,
        meta: expect.objectContaining({ previousStatus: 'APPROVED', status: 'NEEDS_REVIEW', changes: { garmentLayer: 'OUTERWEAR', scale: 1.2 } }),
      }),
    }));
    expect(app.prisma.$transaction).toHaveBeenCalledOnce();
    await app.close();
  });

  it('rejects a stale review without recording an audit event', async () => {
    const { app, tx, storage } = createTestApp();
    tx.product3DAsset.updateMany.mockResolvedValue({ count: 0 });
    await start(app, storage);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/fitting-room/assets/${assetId}/review`,
      payload: { action: 'approve' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: 'ASSET_CHANGED_RETRY' });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects stale metadata edits without recording an audit event', async () => {
    const { app, tx, storage } = createTestApp('APPROVED');
    tx.product3DAsset.updateMany.mockResolvedValue({ count: 0 });
    await start(app, storage);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/fitting-room/assets/${assetId}`,
      payload: { scale: 1.2 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: 'ASSET_CHANGED_RETRY' });
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not delete storage when a concurrent asset edit wins the race', async () => {
    const { app, tx, storage } = createTestApp();
    tx.product3DAsset.deleteMany.mockResolvedValue({ count: 0 });
    await start(app, storage);

    const response = await app.inject({ method: 'DELETE', url: `/api/v1/admin/fitting-room/assets/${assetId}` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: 'ASSET_CHANGED_RETRY' });
    expect(storage.delete).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('creates an idempotent local generation job only for images belonging to the selected product', async () => {
    const { app, prisma, tx, storage } = createTestApp();
    vi.mocked(featureFlags.isEnabled).mockImplementation((flag) => flag === 'LOCAL_3D_GENERATION');
    await start(app, storage);

    const payload = { sourceImageIds: [imageId], garmentLayer: 'BASE_TOP' };
    const headers = { 'idempotency-key': 'fit-gen-1' };
    const first = await app.inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/fitting-room/generation-jobs`, headers, payload });
    const replay = await app.inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/fitting-room/generation-jobs`, headers, payload });

    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ id: jobId, status: 'QUEUED', sourceImageIds: [imageId], garmentLayer: 'BASE_TOP' });
    expect(replay.statusCode).toBe(200);
    expect(prisma.commerceProductImage.findMany).toHaveBeenCalledWith({ where: { id: { in: [imageId] }, productId }, select: { id: true } });
    expect(tx.product3DGenerationJob.create).toHaveBeenCalledOnce();
    expect(tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'PRODUCT_3D_GENERATION_QUEUED', userId }) }));
    await app.close();
  });

  it('rejects generation requests that reuse an idempotency key with different inputs', async () => {
    const { app, tx, prisma, storage } = createTestApp();
    vi.mocked(featureFlags.isEnabled).mockImplementation((flag) => flag === 'LOCAL_3D_GENERATION');
    await start(app, storage);
    const headers = { 'idempotency-key': 'fit-gen-2' };
    const url = `/api/v1/admin/products/${productId}/fitting-room/generation-jobs`;
    await app.inject({ method: 'POST', url, headers, payload: { sourceImageIds: [imageId], garmentLayer: 'BASE_TOP' } });
    const conflict = await app.inject({ method: 'POST', url, headers, payload: { sourceImageIds: [imageId], garmentLayer: 'OUTERWEAR' } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(tx.product3DGenerationJob.create).toHaveBeenCalledOnce();
    await app.close();
  });

  it('rejects a source image from another product before enqueuing work', async () => {
    const { app, prisma, tx, storage } = createTestApp();
    vi.mocked(featureFlags.isEnabled).mockImplementation((flag) => flag === 'LOCAL_3D_GENERATION');
    prisma.commerceProductImage.findMany.mockResolvedValue([]);
    await start(app, storage);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/products/${productId}/fitting-room/generation-jobs`,
      headers: { 'idempotency-key': 'fit-gen-3' },
      payload: { sourceImageIds: [imageId], garmentLayer: 'BASE_TOP' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'SOURCE_IMAGES_NOT_AVAILABLE' });
    expect(tx.product3DGenerationJob.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('cancels queued jobs and allows bounded retry of failed jobs', async () => {
    const { app, storage, job } = createTestApp();
    await start(app, storage);

    const cancellation = await app.inject({ method: 'POST', url: `/api/v1/admin/fitting-room/generation-jobs/${jobId}/cancel` });
    expect(cancellation.statusCode).toBe(200);
    expect(cancellation.json()).toEqual({ id: jobId, status: 'CANCELLED' });

    job.status = 'FAILED';
    job.attemptCount = 1;
    const retry = await app.inject({ method: 'POST', url: `/api/v1/admin/fitting-room/generation-jobs/${jobId}/retry` });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ id: jobId, status: 'QUEUED', attemptCount: 1, errorCode: null });
    await app.close();
  });
});
