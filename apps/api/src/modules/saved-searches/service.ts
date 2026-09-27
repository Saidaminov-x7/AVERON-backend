// apps/api/src/modules/saved-searches/service.ts

import { PrismaClient, Listing } from '@prisma/client';
import { CreateSavedSearchDto } from './schemas';
import { FastifyBaseLogger } from 'fastify';

export class SavedSearchesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger?: FastifyBaseLogger,
  ) {}

  async create(userId: string, dto: CreateSavedSearchDto) {
    const existingCount = await this.prisma.savedSearch.count({ where: { userId } });
    if (existingCount >= 20) {
      throw Object.assign(new Error('Достигнут лимит сохранённых поисков (20 на пользователя)'), { statusCode: 400 });
    }

    return this.prisma.savedSearch.create({
      data: {
        userId,
        name: dto.name,
        filters: dto.filters,
      },
    });
  }

  async findByUser(userId: string) {
    return this.prisma.savedSearch.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getById(id: string, requestingUserId: string, isAdmin = false) {
    const entity = await this.prisma.savedSearch.findUnique({ where: { id } });
    if (!entity) {
      throw Object.assign(new Error('Saved search not found'), { statusCode: 404 });
    }
    if (!isAdmin && entity.userId !== requestingUserId) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }
    return entity;
  }

  async delete(id: string, userId: string, isAdmin = false) {
    const existing = await this.prisma.savedSearch.findUnique({ where: { id } });
    if (!existing) throw Object.assign(new Error('Saved search not found'), { statusCode: 404 });
    if (!isAdmin && existing.userId !== userId) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });

    await this.prisma.savedSearch.delete({ where: { id } });
  }

  /**
   * Проверка совпадения нового одобренного объявления с сохранёнными поисками
   */
  async matchListingAgainstSearches(listing: Listing) {
    const activeSearches = await this.prisma.savedSearch.findMany({
      where: { isActive: true },
      include: { user: { select: { id: true, email: true, name: true } } },
    });

    const matchedUsers: string[] = [];

    for (const search of activeSearches) {
      const f = search.filters as Record<string, any>;
      if (!f) continue;

      const matchesCity = !f.city || (listing.city && listing.city.toLowerCase().includes(f.city.toLowerCase()));
      const matchesDistrict = !f.district || (listing.district && listing.district.toLowerCase().includes(f.district.toLowerCase()));
      const matchesMinPrice = !f.minPrice || Number(listing.price) >= Number(f.minPrice);
      const matchesMaxPrice = !f.maxPrice || Number(listing.price) <= Number(f.maxPrice);
      const matchesRooms = !f.rooms || listing.rooms === Number(f.rooms);
      const matchesType = !f.type || listing.type === f.type;

      if (matchesCity && matchesDistrict && matchesMinPrice && matchesMaxPrice && matchesRooms && matchesType) {
        matchedUsers.push(search.userId);
        await this.prisma.savedSearch.update({
          where: { id: search.id },
          data: { lastNotifiedAt: new Date() },
        });

        // Создаем уведомление для пользователя
        await this.prisma.adminNotification.create({
          data: {
            targetAdminId: search.userId,
            type: 'SAVED_SEARCH_MATCH',
            title: `Новое объявление по вашему поиску: "${search.name}"`,
            message: `Появилась недвижимость: "${listing.title}" за ${listing.price} сум в районе ${listing.district || listing.city}.`,
            link: `/catalog/${listing.id}`,
          },
        });
      }
    }

    if (this.logger && matchedUsers.length > 0) {
      this.logger.info({ listingId: listing.id, matchedCount: matchedUsers.length }, '[SavedSearches] Matched searches notified');
    }

    return matchedUsers;
  }
}
