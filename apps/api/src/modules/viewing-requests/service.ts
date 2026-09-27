// apps/api/src/modules/viewing-requests/service.ts

import { PrismaClient, ViewingStatus } from '@prisma/client';

export function createViewingRequestsService(prisma: PrismaClient) {
  return {
    async create(listingId: string, requesterId: string, preferredDate?: string, message?: string) {
      const listing = await prisma.listing.findUnique({ where: { id: listingId } });
      if (!listing) {
        const error = new Error('Объявление не найдено') as Error & { statusCode: number };
        error.statusCode = 404;
        throw error;
      }

      // Защита от спама: не более 5 заявок в сутки от одного пользователя на одно объявление
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentCount = await prisma.viewingRequest.count({
        where: {
          listingId,
          requesterId,
          createdAt: { gte: oneDayAgo },
        },
      });
      if (recentCount >= 5) {
        const error = new Error('Вы уже отправили максимальное количество заявок на этот объект за последние 24 часа') as Error & { statusCode: number };
        error.statusCode = 400;
        throw error;
      }

      const request = await prisma.viewingRequest.create({
        data: {
          listingId,
          requesterId,
          preferredDate: preferredDate ? new Date(preferredDate) : null,
          message,
          status: 'PENDING',
        },
        include: {
          listing: { select: { id: true, title: true, ownerId: true } },
          requester: { select: { id: true, name: true, phone: true, email: true } },
        },
      });

      // Уведомляем владельца через AdminNotification
      await prisma.adminNotification.create({
        data: {
          type: 'VIEWING_REQUEST',
          title: 'Новая заявка на просмотр',
          message: `Пользователь ${request.requester.name} хочет посмотреть объект "${request.listing.title}"`,
          link: `/admin/viewing-requests`,
        },
      });

      return request;
    },

    async getUserRequests(requesterId: string) {
      return prisma.viewingRequest.findMany({
        where: { requesterId },
        include: {
          listing: {
            select: {
              id: true,
              title: true,
              address: true,
              city: true,
              price: true,
              images: { take: 1, select: { url: true } },
              owner: { select: { id: true, name: true, phone: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });
    },

    async getAdminOrOwnerRequests(userId: string, isAdmin: boolean) {
      if (isAdmin) {
        return prisma.viewingRequest.findMany({
          include: {
            listing: { select: { id: true, title: true, ownerId: true } },
            requester: { select: { id: true, name: true, phone: true, email: true } },
          },
          orderBy: { createdAt: 'desc' },
        });
      }

      // Возвращаем заявки на объекты данного владельца
      return prisma.viewingRequest.findMany({
        where: {
          listing: { ownerId: userId },
        },
        include: {
          listing: { select: { id: true, title: true, ownerId: true } },
          requester: { select: { id: true, name: true, phone: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
    },

    async updateStatus(id: string, userId: string, isAdmin: boolean, status: ViewingStatus) {
      const viewing = await prisma.viewingRequest.findUnique({
        where: { id },
        include: { listing: { select: { ownerId: true } } },
      });

      if (!viewing) {
        const error = new Error('Заявка не найдена') as Error & { statusCode: number };
        error.statusCode = 404;
        throw error;
      }

      if (!isAdmin && viewing.listing.ownerId !== userId) {
        const error = new Error('Нет прав для изменения этой заявки') as Error & { statusCode: number };
        error.statusCode = 403;
        throw error;
      }

      return prisma.viewingRequest.update({
        where: { id },
        data: { status },
      });
    },
  };
}
