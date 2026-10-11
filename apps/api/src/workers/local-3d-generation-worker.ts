import 'dotenv/config';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createLocal3dWorkerId, runOneLocal3dGenerationJob, type Local3dGenerator } from '../modules/commerce/local-3d-generation-worker';

async function main() {
  const configuredModule = process.env.LOCAL_3D_GENERATOR_MODULE?.trim();
  if (!configuredModule || !isAbsolute(configuredModule)) {
    console.error('LOCAL_3D_GENERATOR_MODULE must point to an installed, absolute-path local generator module. No jobs were claimed.');
    process.exitCode = 78;
    return;
  }

  const module = await import(pathToFileURL(configuredModule).href) as { generateGarmentGlb?: Local3dGenerator };
  if (typeof module.generateGarmentGlb !== 'function') {
    throw new Error('Configured local generator module must export generateGarmentGlb(request).');
  }

  const prisma = new PrismaClient();
  const workerId = createLocal3dWorkerId();
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });
  try {
    while (!stopping) {
      const result = await runOneLocal3dGenerationJob({ prisma, workerId, generator: module.generateGarmentGlb });
      if (result.outcome === 'idle') await new Promise((resolve) => setTimeout(resolve, 1500));
      else if (result.outcome === 'failed') console.error(`Local 3D generation job ${result.jobId} failed (${result.code}).`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error('Local 3D generation worker stopped unexpectedly.', error);
  process.exitCode = 1;
});
