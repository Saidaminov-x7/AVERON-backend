// apps/api/src/modules/auth/export.ts
// GDPR экспорт всех персональных данных пользователя

import { FastifyRequest, FastifyReply } from 'fastify';

export async function exportUserDataHandler(request: FastifyRequest, reply: FastifyReply) {
  const prisma = request.server.prisma;
  const userId = request.user?.userId;

  if (!userId) {
    return reply.status(401).send({ message: 'Unauthorized' });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      listings: {
        include: {
          images: true,
          priceHistory: true,
          reports: true,
        },
      },
      favorites: {
        include: {
          listing: {
            select: { id: true, title: true, city: true, price: true },
          },
        },
      },
      savedSearches: true,
      viewingRequests: true,
      sentMessages: {
        take: 1000,
        orderBy: { createdAt: 'asc' },
      },
      receivedMessages: {
        take: 1000,
        orderBy: { createdAt: 'asc' },
      },
      reviewsWritten: true,
      reviewsReceived: true,
      userActivityLogs: {
        take: 500,
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!user) {
    return reply.status(404).send({ message: 'Пользователь не найден' });
  }

  // Санитизация чувствительных полей хэшей
  const { passwordHash, refreshTokenHash, twoFactorSecret, ...safeUserData } = user;

  const exportData = {
    metadata: {
      exportDate: new Date().toISOString(),
      platform: 'Ijarauz Platform',
      version: '1.0.0',
    },
    user: safeUserData,
  };

  reply.header('Content-Type', 'application/json; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="ijarauz-data-export-${userId}.json"`);
  return reply.send(exportData);
}
