import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { runScheduledBackup } from '../lib/jobs/scheduled-backup';
import { retryPendingWebhookDeliveries } from '../lib/webhookDelivery';

const DAY_MS = 24 * 60 * 60 * 1000;
const prisma = new PrismaClient();

async function run() {
  const latestSnapshot = await prisma.backupSnapshot.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (!latestSnapshot || Date.now() - latestSnapshot.createdAt.getTime() >= DAY_MS) {
    await runScheduledBackup(prisma);
  }

  const result = await retryPendingWebhookDeliveries(prisma);
  console.info(`[Maintenance] Webhook retry pass complete: retried=${result.retried}, succeeded=${result.succeeded}, failed=${result.failed}`);
}

run()
  .catch((error: unknown) => {
    console.error('[Maintenance] Scheduled task failed', error instanceof Error ? error.name : 'UnknownError');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
