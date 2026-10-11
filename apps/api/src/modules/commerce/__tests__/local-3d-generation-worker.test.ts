import { describe, expect, it, vi } from 'vitest';
import { runOneLocal3dGenerationJob } from '../local-3d-generation-worker';

const job = {
  id: '00000000-0000-4000-8000-000000000030',
  productId: '00000000-0000-4000-8000-000000000010',
  variantId: null,
  initiatedById: '00000000-0000-4000-8000-000000000001',
  sourceImageIds: ['00000000-0000-4000-8000-000000000040'],
  garmentLayer: 'BASE_TOP',
  leaseToken: 'lease-token',
};

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

describe('local 3D generation worker', () => {
  it('claims a queued job and fails transparently when no local garment model is configured', async () => {
    const updateMany = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (data.status === 'RUNNING') return { count: 1 };
      return { count: 1 };
    });
    const findFirst = vi.fn()
      .mockResolvedValueOnce({ id: job.id })
      .mockResolvedValueOnce(null);
    const findUnique = vi.fn(async () => job);
    const prisma = {
      product3DGenerationJob: { findFirst, findUnique, updateMany },
    } as never;

    const result = await runOneLocal3dGenerationJob({ prisma, workerId: 'fixture-worker' });

    expect(result).toEqual({ outcome: 'failed', jobId: job.id, code: 'LOCAL_GENERATOR_NOT_CONFIGURED' });
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: job.id, status: 'RUNNING', leaseToken: expect.any(String) },
      data: expect.objectContaining({ status: 'FAILED', errorCode: 'LOCAL_GENERATOR_NOT_CONFIGURED' }),
    }));
  });

  it('does not claim a job when the queue is empty', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { product3DGenerationJob: { findFirst } } as never;

    const result = await runOneLocal3dGenerationJob({ prisma, workerId: 'fixture-worker' });

    expect(result).toEqual({ outcome: 'idle' });
    expect(findFirst).toHaveBeenCalledOnce();
  });

  it('validates generated GLB, stores it privately, and leaves the asset pending human review', async () => {
    const findFirst = vi.fn().mockResolvedValueOnce({ id: job.id, status: 'QUEUED', leaseToken: null, attemptCount: 0, maxAttempts: 3, cancelRequestedAt: null }).mockResolvedValueOnce(null);
    const claimedJob = { ...job, attemptCount: 1 };
    const tx = {
      product3DGenerationJob: {
        findFirst: vi.fn(async () => ({ id: job.id })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      product3DAsset: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: '00000000-0000-4000-8000-000000000050', ...data })) },
      auditLog: { create: vi.fn(async () => ({})) },
    };
    const prisma = {
      product3DGenerationJob: {
        findFirst,
        findUnique: vi.fn(async () => claimedJob),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    } as never;
    const storage = { upload: vi.fn(async () => 'private/generated-fixture.glb'), delete: vi.fn() };
    const generated = makeValidGlb();
    const generator = vi.fn(async () => generated);

    const result = await runOneLocal3dGenerationJob({ prisma, workerId: 'fixture-worker', generator, storage });

    expect(result).toEqual({ outcome: 'needs-review', jobId: job.id });
    expect(generator).toHaveBeenCalledWith(expect.objectContaining({ jobId: job.id, productId: job.productId, sourceImageIds: job.sourceImageIds }));
    expect(storage.upload).toHaveBeenCalledOnce();
    expect(tx.product3DAsset.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      fileKey: 'private/generated-fixture.glb', source: 'LOCAL_GENERATION', status: 'NEEDS_REVIEW', sourceImageIds: job.sourceImageIds,
    }) });
    expect(tx.product3DGenerationJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'NEEDS_REVIEW', stage: 'NEEDS_REVIEW' }) }));
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
  });
});
