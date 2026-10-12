import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { FittingGarmentLayer, Product3DAssetSource, Product3DAssetStatus, Product3DGenerationStatus } from '@prisma/client';
import { Cloudinary3dStorage } from './cloudinary-3d-storage';
import { validateGlbWithKhronos } from './glb-validation';

const LEASE_MS = 10 * 60 * 1000;
const MAX_ERROR_LENGTH = 500;

export type Local3dGenerationRequest = {
  jobId: string;
  productId: string;
  variantId: string | null;
  sourceImageIds: string[];
  garmentLayer: FittingGarmentLayer;
};

export type Local3dGenerator = (request: Local3dGenerationRequest) => Promise<Uint8Array>;

type GenerationWorkerDependencies = {
  prisma: PrismaClient;
  workerId: string;
  generator?: Local3dGenerator;
  storage?: Pick<Cloudinary3dStorage, 'upload' | 'delete'>;
};

/** Claims work with a compare-and-set update so multiple local workers cannot process one queue row. */
export async function claimNextLocal3dGenerationJob(prisma: PrismaClient, workerId: string) {
  const now = new Date();
  const candidate = await prisma.product3DGenerationJob.findFirst({
    where: { OR: [
      { status: Product3DGenerationStatus.QUEUED, nextAttemptAt: { lte: now }, cancelRequestedAt: null },
      { status: Product3DGenerationStatus.RUNNING, leaseExpiresAt: { lte: now } },
    ] },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, status: true, leaseToken: true, attemptCount: true, maxAttempts: true, cancelRequestedAt: true },
  });
  if (!candidate) return null;
  if (candidate.status === Product3DGenerationStatus.RUNNING && candidate.cancelRequestedAt) {
    await prisma.product3DGenerationJob.updateMany({
      where: { id: candidate.id, status: Product3DGenerationStatus.RUNNING, leaseToken: candidate.leaseToken, cancelRequestedAt: { not: null }, leaseExpiresAt: { lte: now } },
      data: { status: Product3DGenerationStatus.CANCELLED, stage: 'CANCELLED', completedAt: now, workerId: null, leaseToken: null, leaseExpiresAt: null },
    });
    return null;
  }
  if (candidate.status === Product3DGenerationStatus.RUNNING && candidate.attemptCount >= candidate.maxAttempts) {
    await prisma.product3DGenerationJob.updateMany({
      where: { id: candidate.id, status: Product3DGenerationStatus.RUNNING, leaseToken: candidate.leaseToken, leaseExpiresAt: { lte: now } },
      data: { status: Product3DGenerationStatus.FAILED, stage: 'FAILED', errorCode: 'WORKER_LEASE_EXPIRED', errorMessage: 'The local worker stopped before this job completed.', completedAt: now, workerId: null, leaseToken: null, leaseExpiresAt: null },
    });
    return null;
  }
  const leaseToken = randomUUID();
  const claimed = await prisma.product3DGenerationJob.updateMany({
    where: candidate.status === Product3DGenerationStatus.QUEUED
      ? { id: candidate.id, status: Product3DGenerationStatus.QUEUED, nextAttemptAt: { lte: now }, cancelRequestedAt: null }
      : { id: candidate.id, status: Product3DGenerationStatus.RUNNING, leaseToken: candidate.leaseToken, leaseExpiresAt: { lte: now } },
    data: {
      status: Product3DGenerationStatus.RUNNING,
      stage: 'GENERATING',
      workerId,
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      startedAt: now,
      attemptCount: { increment: 1 },
      errorCode: null,
      errorMessage: null,
    },
  });
  if (claimed.count !== 1) return null;
  const job = await prisma.product3DGenerationJob.findUnique({ where: { id: candidate.id } });
  return job ? { ...job, leaseToken } : null;
}

/** Runs one job. Without a configured local model this fails transparently and never fabricates an asset. */
export async function runOneLocal3dGenerationJob(dependencies: GenerationWorkerDependencies) {
  const { prisma, workerId, generator } = dependencies;
  const job = await claimNextLocal3dGenerationJob(prisma, workerId);
  if (!job) return { outcome: 'idle' as const };
  const leaseWhere = { id: job.id, status: Product3DGenerationStatus.RUNNING, leaseToken: job.leaseToken };
  const cancelRequested = await prisma.product3DGenerationJob.findFirst({
    where: { ...leaseWhere, cancelRequestedAt: { not: null } }, select: { id: true },
  });
  if (cancelRequested) {
    await prisma.product3DGenerationJob.updateMany({ where: leaseWhere, data: {
      status: Product3DGenerationStatus.CANCELLED, stage: 'CANCELLED', completedAt: new Date(), workerId: null, leaseToken: null, leaseExpiresAt: null,
    } });
    return { outcome: 'cancelled' as const, jobId: job.id };
  }
  if (!generator) {
    await prisma.product3DGenerationJob.updateMany({ where: leaseWhere, data: {
      status: Product3DGenerationStatus.FAILED, stage: 'FAILED', errorCode: 'LOCAL_GENERATOR_NOT_CONFIGURED',
      errorMessage: 'No compatible local garment-to-3D model is configured for this worker.', completedAt: new Date(), workerId: null, leaseToken: null, leaseExpiresAt: null,
    } });
    return { outcome: 'failed' as const, jobId: job.id, code: 'LOCAL_GENERATOR_NOT_CONFIGURED' };
  }

  let fileKey: string | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    let heartbeatInFlight = false;
    heartbeat = setInterval(async () => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      try {
        await prisma.product3DGenerationJob.updateMany({ where: leaseWhere, data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } }).catch(() => undefined);
      } finally {
        heartbeatInFlight = false;
      }
    }, Math.max(15_000, Math.floor(LEASE_MS / 3)));
    heartbeat.unref?.();
    const generated = Buffer.from(await generator({
      jobId: job.id,
      productId: job.productId,
      variantId: job.variantId,
      sourceImageIds: job.sourceImageIds,
      garmentLayer: job.garmentLayer,
    }));
    const validation = await validateGlbWithKhronos(generated);
    const storage = dependencies.storage ?? new Cloudinary3dStorage();
    fileKey = await storage.upload(generated, validation.fileHash);
    const persisted = await prisma.$transaction(async (tx) => {
      const current = await tx.product3DGenerationJob.findFirst({ where: { ...leaseWhere, cancelRequestedAt: null }, select: { id: true } });
      if (!current) {
        await tx.product3DGenerationJob.updateMany({ where: { ...leaseWhere, cancelRequestedAt: { not: null } }, data: {
          status: Product3DGenerationStatus.CANCELLED,
          stage: 'CANCELLED',
          completedAt: new Date(),
          workerId: null,
          leaseToken: null,
          leaseExpiresAt: null,
        } });
        return false;
      }
      const asset = await tx.product3DAsset.create({ data: {
        productId: job.productId,
        variantId: job.variantId,
        fileKey: fileKey!,
        fileHash: validation.fileHash,
        fileSize: validation.fileSize,
        status: Product3DAssetStatus.NEEDS_REVIEW,
        source: Product3DAssetSource.LOCAL_GENERATION,
        garmentLayer: job.garmentLayer,
        mannequinVersion: 'averon-neutral-v1',
        sourceImageIds: job.sourceImageIds,
        validationSummary: validation.warningCount ? `Generated GLB passed validation with ${validation.warningCount} warning(s).` : 'Generated GLB passed Khronos validation.',
        validationDetails: { meshCount: validation.meshCount, vertexCount: validation.vertexCount, materialCount: validation.materialCount, textureCount: validation.textureCount, validatorWarningCount: validation.warningCount, validatorWarnings: validation.warnings },
      } });
      const updated = await tx.product3DGenerationJob.updateMany({ where: leaseWhere, data: {
        status: Product3DGenerationStatus.NEEDS_REVIEW,
        stage: 'NEEDS_REVIEW',
        resultAssetId: asset.id,
        completedAt: new Date(),
        workerId: null,
        leaseToken: null,
        leaseExpiresAt: null,
      } });
      if (updated.count !== 1) throw new Error('GENERATION_LEASE_LOST');
      await tx.auditLog.create({ data: {
        userId: job.initiatedById,
        action: 'PRODUCT_3D_GENERATION_COMPLETED',
        resource: 'Product3DAsset',
        resourceId: asset.id,
        meta: { productId: job.productId, jobId: job.id, reviewRequired: true },
      } });
      return true;
    });
    if (!persisted) {
      await storage.delete(fileKey);
      return { outcome: 'cancelled' as const, jobId: job.id };
    }
    return { outcome: 'needs-review' as const, jobId: job.id };
  } catch (error) {
    if (fileKey) await (dependencies.storage ?? new Cloudinary3dStorage()).delete(fileKey).catch(() => undefined);
    const message = error instanceof Error ? error.message.slice(0, MAX_ERROR_LENGTH) : 'Local 3D generation failed.';
    const willRetry = job.attemptCount < job.maxAttempts;
    const backoffMs = Math.min(10 * 60_000, 30_000 * (2 ** Math.max(0, job.attemptCount - 1)));
    await prisma.product3DGenerationJob.updateMany({ where: leaseWhere, data: {
      status: willRetry ? Product3DGenerationStatus.QUEUED : Product3DGenerationStatus.FAILED,
      stage: willRetry ? 'RETRY_WAIT' : 'FAILED',
      errorCode: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code.slice(0, 80) : 'LOCAL_GENERATION_FAILED',
      errorMessage: message,
      nextAttemptAt: willRetry ? new Date(Date.now() + backoffMs) : undefined,
      completedAt: willRetry ? null : new Date(),
      workerId: null,
      leaseToken: null,
      leaseExpiresAt: null,
    } });
    return { outcome: 'failed' as const, jobId: job.id, code: 'LOCAL_GENERATION_FAILED' };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

export function createLocal3dWorkerId() {
  return `averon-3d-${process.pid}-${randomUUID()}`;
}
