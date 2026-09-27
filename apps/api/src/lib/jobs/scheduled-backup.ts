// apps/api/src/lib/jobs/scheduled-backup.ts
import { PrismaClient } from '@prisma/client';
import { FastifyBaseLogger } from 'fastify';

/**
 * Ежедневная фоновая задача создания записи снапшота целостности базы данных
 */
export async function runScheduledBackup(prisma: PrismaClient, logger?: FastifyBaseLogger) {
  try {
    const [listingsCount, usersCount, reportsCount] = await Promise.all([
      prisma.listing.count(),
      prisma.user.count(),
      prisma.listingReport.count(),
    ]);

    const snapshot = await prisma.backupSnapshot.create({
      data: {
        type: 'SCHEDULED',
        status: 'COMPLETED',
        recordCounts: {
          listings: listingsCount,
          users: usersCount,
          reports: reportsCount,
        },
      },
    });

    logger?.info(
      { snapshotId: snapshot.id, recordCounts: snapshot.recordCounts },
      '[Backup] Scheduled backup snapshot record created successfully',
    );
  } catch (err) {
    logger?.error({ err }, '[Backup] Scheduled backup snapshot creation failed');
  }
}
