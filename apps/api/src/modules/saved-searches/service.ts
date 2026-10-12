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
      const rawFilters = search.filters;
      if (!rawFilters || typeof rawFilters !== 'object' || Array.isArray(rawFilters)) continue;
      const f = rawFilters as Record<string, unknown>;
      const city = typeof f.city === 'string' ? f.city : '';
      const district = typeof f.district === 'string' ? f.district : '';
      const minPrice = typeof f.minPrice === 'number' || typeof f.minPrice === 'string' ? Number(f.minPrice) : null;
      const maxPrice = typeof f.maxPrice === 'number' || typeof f.maxPrice === 'string' ? Number(f.maxPrice) : null;
      const rooms = typeof f.rooms === 'number' || typeof f.rooms === 'string' ? Number(f.rooms) : null;
      const type = typeof f.type === 'string' ? f.type : null;

      const matchesCity = !city || Boolean(listing.city && listing.city.toLowerCase().includes(city.toLowerCase()));
      const matchesDistrict = !district || Boolean(listing.district && listing.district.toLowerCase().includes(district.toLowerCase()));
      const matchesMinPrice = minPrice === null || Number(listing.price) >= minPrice;
      const matchesMaxPrice = maxPrice === null || Number(listing.price) <= maxPrice;
      const matchesRooms = rooms === null || listing.rooms === rooms;
      const matchesType = type === null || listing.type === type;

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
