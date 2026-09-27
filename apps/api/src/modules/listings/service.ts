// apps/api/src/modules/listings/service.ts

import { PrismaClient, Listing, ListingStatus, ModerationStatus, Prisma } from '@prisma/client';
import { CreateListingDto, UpdateListingDto, ListingsFilterDto } from './schemas';
import { config } from '../../config';
import { FastifyBaseLogger } from 'fastify';
import { detectSuspiciousContent } from '../../lib/pre-moderation';

interface AIModerationResult {
  approved: boolean;
  reason?: string;
  spamScore?: number;
  fraudScore?: number;
}

class AIModerationService {
  private readonly ollamaBaseUrl: string;
  private readonly ollamaModel: string;

  constructor(private readonly logger?: FastifyBaseLogger) {
    this.ollamaBaseUrl = config.OLLAMA_BASE_URL;
    this.ollamaModel = config.OLLAMA_MODEL || 'llama3';
  }

  async checkListing(dto: CreateListingDto): Promise<AIModerationResult> {
    try {
      const prompt = `
        Ты — система модерации объявлений о недвижимости.
        Твоя задача — проверить объявление на спам, мошенничество и нарушение правил платформы.
        
        Объявление:
        - Название: ${dto.title}
        - Описание: ${dto.description}
        - Цена: ${dto.price} сум
        - Тип: ${dto.type}
        - Комнат: ${dto.rooms}
        - Площадь: ${dto.area} м²
        - Город: ${dto.city}
        - Район: ${dto.district}
        
        Правила модерации:
        1. Запрещены объявления с подозрительно низкой ценой (например, квартира в центре Ташкента за $100).
        2. Запрещены объявления с подозрительно высокой ценой (например, комната за $100,000).
        3. Запрещены объявления с признаками мошенничества (например, "срочно продам, нужны деньги на операцию").
        4. Запрещены объявления с контактными данными в описании (телефон, email, Telegram, WhatsApp).
        5. Запрещены объявления с подозрительными ссылками (например, "подробности на сайте xxx.com").
        6. Запрещены объявления с оскорбительным или неуместным содержанием.
        
        Ответь в формате JSON с полями:
        - approved: boolean (true, если объявление прошло модерацию)
        - reason: string (причина отклонения, если approved = false)
        - spamScore: number (0-1, вероятность спама)
        - fraudScore: number (0-1, вероятность мошенничества)
      `;

      // C7: Таймаут 5 секунд — недоступность Ollama не блокирует публикацию объявления
      const response = await fetch(`${this.ollamaBaseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(5_000),
        body: JSON.stringify({ model: this.ollamaModel, prompt, format: 'json', stream: false }),
      });
      if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
      const data = await response.json() as { response?: string };
      if (!data.response) throw new Error('Ollama returned an empty response');

      const result = JSON.parse(data.response) as AIModerationResult;
      return {
        approved: result.approved,
        reason: result.reason,
        spamScore: result.spamScore,
        fraudScore: result.fraudScore,
      };
    } catch (err) {
      if (this.logger) {
        this.logger.error({ err }, 'AI moderation error');
      }
      // При ошибке AI — отправляем на ручную модерацию
      return { approved: false, reason: 'AI модерация недоступна' };
    }
  }
}

class AIModerationQueue {
  private queue: Array<{ dto: CreateListingDto; resolve: (result: AIModerationResult) => void }> = [];
  private isProcessing = false;

  constructor(private readonly aiService: AIModerationService) {}

  async add(dto: CreateListingDto): Promise<AIModerationResult> {
    return new Promise((resolve) => {
      this.queue.push({ dto, resolve });
      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    const { dto, resolve } = this.queue.shift()!;
    try {
      const result = await this.aiService.checkListing(dto);
      resolve(result);
    } catch (err) {
      resolve({ approved: false, reason: 'Ошибка AI-модерации' });
    } finally {
      this.isProcessing = false;
      this.processQueue();
    }
  }
}

const sharedAIModerationQueue = new AIModerationQueue(new AIModerationService());

import { Redis } from 'ioredis';

export class ListingsService {
  private readonly aiModerationQueue: AIModerationQueue;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis?: Redis,
    private readonly logger?: FastifyBaseLogger,
  ) {
    this.aiModerationQueue = sharedAIModerationQueue;
  }

  async invalidateCatalogCache(): Promise<void> {
    if (!this.redis) return;
    try {
      const keys = await this.redis.keys('catalog:*');
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } catch (err) {
      if (this.logger) {
        this.logger.warn({ err }, '[ListingsService] Failed to invalidate catalog cache');
      }
    }
  }

  /**
   * Создать объявление (статус DRAFT по умолчанию)
   */
  async create(ownerId: string, dto: CreateListingDto): Promise<Listing> {
    // Проверяем лимит фотографий
    const settings = await this.prisma.siteSettings.findUnique({
      where: { id: "singleton" },
    });
    
    // Новые объявления сразу ACTIVE (опубликованы) + PENDING (ожидают модерации)
    let moderationStatus: ModerationStatus = ModerationStatus.PENDING;
    let status: ListingStatus = ListingStatus.ACTIVE;
    let moderationNote: string | null = null;

    if (settings?.autoModerationEnabled) {
      // Вызываем AI-модерацию
      try {
        const aiResult = await this.aiModerationQueue.add(dto);
        if (aiResult.approved) {
          moderationStatus = ModerationStatus.APPROVED;
          status = ListingStatus.ACTIVE;
        } else {
          // Если AI отклонила объявление — сохраняем причину
          moderationStatus = ModerationStatus.REJECTED;
          moderationNote = aiResult.reason || 'Отклонено AI-модерацией';
        }
      } catch (err) {
        if (this.logger) {
          this.logger.error({ err }, 'AI moderation failed, falling back to manual');
        }
        // Остаёмся в PENDING для ручной модерации
      }
    }

    const suspiciousCheck = detectSuspiciousContent(dto.description);
    if (suspiciousCheck.suspicious) {
      const flagNote = `Автоматически помечено: контакты в описании (${suspiciousCheck.reasons.join(', ')})`;
      moderationNote = moderationNote ? `${moderationNote}; ${flagNote}` : flagNote;
    }

    const listing = await this.prisma.listing.create({
      data: {
        ownerId,
        title: dto.title,
        description: dto.description,
        price: dto.price,
        type: dto.type,
        rooms: dto.rooms,
        area: dto.area,
        floor: dto.floor,
        totalFloors: dto.totalFloors,
        lat: dto.lat,
        lng: dto.lng,
        city: dto.city,
        district: dto.district,
        address: dto.address,
        amenities: dto.amenities,
        status,
        moderationStatus,
        moderationNote,
      },
      include: {
        owner: { select: { id: true, name: true, avatar: true, phone: true } },
        images: true,
      },
    });

    this.invalidateCatalogCache().catch(() => {});

    // Создаем системное уведомление для администраторов (только если не автомодерация)
    if (!settings?.autoModerationEnabled) {
      this.prisma.adminNotification.create({
        data: {
          type: 'NEW_LISTING',
          title: 'Новое объявление',
          message: `Создано объявление "${listing.title}" (${listing.city})`,
          link: '/listings',
        },
      }).catch(() => { });
    }

    return listing;
  }

  /**
   * Получить список объявлений с фильтрацией и пагинацией
   */
  async findMany(filter: ListingsFilterDto) {
    const {
      page,
      limit,
      sortBy,
      sortOrder,
      city,
      district,
      type,
      status,
      minPrice,
      maxPrice,
      minRooms,
      maxRooms,
      amenities,
    } = filter;

    const skip = (page - 1) * limit;

    const { search } = filter;

    let searchCondition: Prisma.ListingWhereInput = {};
    if (search) {
      const settings = await this.prisma.siteSettings.findUnique({ where: { id: 'singleton' } });
      if (settings?.fullTextSearchEnabled) {
        // Полнотекстовый комбинированный поиск по заголовку, описанию и адресу
        searchCondition = {
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } },
            { address: { contains: search, mode: 'insensitive' } },
          ],
        };
      } else {
        // Базовый поиск только по названию
        searchCondition = { title: { contains: search, mode: 'insensitive' } };
      }
    }

    const where: Prisma.ListingWhereInput = {
      // Публичный поиск — только активные и одобренные объявления
      status: status ?? ListingStatus.ACTIVE,
      moderationStatus: ModerationStatus.APPROVED, // Всегда фильтруем по одобренным
      ...searchCondition,
      ...(city && { city: { contains: city, mode: 'insensitive' } }),
      ...(district && { district: { contains: district, mode: 'insensitive' } }),
      ...(type && { type }),
      ...((minPrice !== undefined || maxPrice !== undefined) && {
        price: {
          ...(minPrice !== undefined && { gte: minPrice }),
          ...(maxPrice !== undefined && { lte: maxPrice }),
        },
      }),
      ...((minRooms !== undefined || maxRooms !== undefined) && {
        rooms: {
          ...(minRooms !== undefined && { gte: minRooms }),
          ...(maxRooms !== undefined && { lte: maxRooms }),
        },
      }),
      ...(amenities && amenities.length > 0 && {
        amenities: { hasSome: amenities },
      }),
    };

    const cacheKey = this.redis ? `catalog:${JSON.stringify(filter)}` : null;
    if (cacheKey && this.redis) {
      try {
        const cached = await this.redis.get(cacheKey);
        if (cached) {
          return JSON.parse(cached);
        }
      } catch {}
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.listing.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ isPromoted: 'desc' }, { [sortBy]: sortOrder }],
        include: {
          owner: { select: { id: true, name: true, avatar: true } },
          images: { select: { id: true, url: true, mimeType: true } },
          _count: { select: { favorites: true } },
        },
      }),
      this.prisma.listing.count({ where }),
    ]);

    const listingIds = items.map((i) => i.id);
    let listingReviewMap = new Map<string, { rating: number; reviewsCount: number }>();
    if (listingIds.length > 0) {
      const reviewsGroup = await this.prisma.review.groupBy({
        by: ['listingId'],
        where: { listingId: { in: listingIds } },
        _avg: { rating: true },
        _count: { id: true },
      });
      for (const r of reviewsGroup) {
        if (r.listingId) {
          listingReviewMap.set(r.listingId, {
            rating: r._avg.rating ? Number(r._avg.rating.toFixed(1)) : 5.0,
            reviewsCount: r._count.id,
          });
        }
      }
    }

    const enrichedItems = items.map((item) => {
      const rev = listingReviewMap.get(item.id);
      return {
        ...item,
        rating: rev ? rev.rating : 5.0,
        reviews: rev ? rev.reviewsCount : 0,
        reviewsCount: rev ? rev.reviewsCount : 0,
      };
    });

    const result = {
      items: enrichedItems,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };

    if (cacheKey && this.redis) {
      this.redis.set(cacheKey, JSON.stringify(result), 'EX', 45).catch(() => {});
    }

    return result;
  }

  /**
   * Получить одно объявление по ID (инкремент просмотров)
   */
  async findById(id: string, incrementViews = false): Promise<any | null> {
    const visibilityWhere: Prisma.ListingWhereInput = {
      id,
      status: ListingStatus.ACTIVE,
      moderationStatus: ModerationStatus.APPROVED,
    };
    if (incrementViews) {
      // Атомарный инкремент без дополнительного запроса
      await this.prisma.listing.updateMany({
        where: visibilityWhere,
        data: { viewsCount: { increment: 1 } },
      });
    }

    const listing = await this.prisma.listing.findFirst({
      where: visibilityWhere,
      include: {
        owner: { select: { id: true, name: true, avatar: true, phone: true } },
        images: true,
        _count: { select: { favorites: true } },
      },
    });

    if (!listing) return null;

    // Вычисляем реальный рейтинг объявления и арендодателя
    const [listingReviewAgg, landlordReviewAgg] = await Promise.all([
      this.prisma.review.aggregate({
        where: { listingId: id },
        _avg: { rating: true },
        _count: { id: true },
      }),
      this.prisma.review.aggregate({
        where: { landlordId: listing.ownerId },
        _avg: { rating: true },
        _count: { id: true },
      }),
    ]);

    const listingRating = listingReviewAgg._avg.rating
      ? Number(listingReviewAgg._avg.rating.toFixed(1))
      : (landlordReviewAgg._avg.rating ? Number(landlordReviewAgg._avg.rating.toFixed(1)) : 5.0);
    const listingReviewsCount = listingReviewAgg._count.id || 0;

    const landlordRating = landlordReviewAgg._avg.rating
      ? Number(landlordReviewAgg._avg.rating.toFixed(1))
      : 5.0;
    const landlordReviewsCount = landlordReviewAgg._count.id || 0;

    return {
      ...listing,
      rating: listingRating,
      reviews: listingReviewsCount,
      reviewsCount: listingReviewsCount,
      owner: listing.owner
        ? {
            ...listing.owner,
            rating: landlordRating,
            reviewsCount: landlordReviewsCount,
          }
        : null,
    };
  }

  /**
   * Обновить объявление (только владелец)
   */
  async update(id: string, ownerId: string, dto: UpdateListingDto): Promise<Listing> {
    // Проверяем владельца
    const existing = await this.prisma.listing.findUnique({ where: { id } });
    if (!existing) throw Object.assign(new Error('Listing not found'), { statusCode: 404 });
    if (existing.ownerId !== ownerId) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });

    const settings = await this.prisma.siteSettings.findUnique({ where: { id: 'singleton' } });
    const isAutoModerated = settings?.autoModerationEnabled === true;

    // Если цена изменилась — фиксируем в истории цен
    if (dto.price !== undefined && Number(dto.price) !== Number(existing.price)) {
      await this.prisma.priceHistory.create({
        data: {
          listingId: id,
          price: dto.price,
        },
      });
    }

    const updated = await this.prisma.listing.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.price !== undefined && { price: dto.price }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.rooms !== undefined && { rooms: dto.rooms }),
        ...(dto.area !== undefined && { area: dto.area }),
        ...(dto.floor !== undefined && { floor: dto.floor }),
        ...(dto.totalFloors !== undefined && { totalFloors: dto.totalFloors }),
        ...(dto.city !== undefined && { city: dto.city }),
        ...(dto.district !== undefined && { district: dto.district }),
        ...(dto.address !== undefined && { address: dto.address }),
        ...(dto.amenities !== undefined && { amenities: dto.amenities }),
        // При редактировании: объявление остаётся ACTIVE, но модерация сбрасывается в PENDING
        // (кроме случая автомодерации — тогда сразу APPROVED)
        status: ListingStatus.ACTIVE,
        moderationStatus: isAutoModerated ? ModerationStatus.APPROVED : ModerationStatus.PENDING,
        moderationNote: null,
      },
      include: { owner: { select: { id: true, name: true, avatar: true } }, images: true },
    });

    this.invalidateCatalogCache().catch(() => {});
    return updated;
  }

  /**
   * Мягкое удаление (статус DELETED)
   */
  async delete(id: string, ownerId: string, isAdmin = false): Promise<void> {
    const existing = await this.prisma.listing.findUnique({ where: { id } });
    if (!existing) throw Object.assign(new Error('Listing not found'), { statusCode: 404 });
    if (!isAdmin && existing.ownerId !== ownerId) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }

    await this.prisma.listing.update({
      where: { id },
      data: { status: ListingStatus.DELETED },
    });

    this.invalidateCatalogCache().catch(() => {});
  }

  /**
   * Мои объявления (все статусы)
   */
  async findMyListings(ownerId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.listing.findMany({
        where: { ownerId, status: { not: ListingStatus.DELETED } },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          images: { select: { id: true, url: true } },
          _count: { select: { favorites: true } },
        },
      }),
      this.prisma.listing.count({
        where: { ownerId, status: { not: ListingStatus.DELETED } },
      }),
    ]);

    return { items, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  /**
   * Добавить/убрать из избранного
   */
  async toggleFavorite(userId: string, listingId: string): Promise<{ favorited: boolean }> {
    const existing = await this.prisma.favorite.findUnique({
      where: { userId_listingId: { userId, listingId } },
    });

    if (existing) {
      await this.prisma.favorite.delete({
        where: { userId_listingId: { userId, listingId } },
      });
      return { favorited: false };
    } else {
      await this.prisma.favorite.create({ data: { userId, listingId } });
      return { favorited: true };
    }
  }

  /**
   * Избранные объявления пользователя
   */
  async getFavorites(userId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.favorite.findMany({
        where: { userId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          listing: {
            include: {
              images: { select: { id: true, url: true } },
              owner: { select: { id: true, name: true } },
            },
          },
        },
      }),
      this.prisma.favorite.count({ where: { userId } }),
    ]);

    return {
      items: items.map((f) => f.listing),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Опубликовать объявление (DRAFT → ACTIVE)
   */
  async publish(id: string, ownerId: string): Promise<Listing> {
    const existing = await this.prisma.listing.findUnique({ where: { id } });
    if (!existing) throw Object.assign(new Error('Listing not found'), { statusCode: 404 });
    if (existing.ownerId !== ownerId) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });

    if (existing.status === ListingStatus.ACTIVE) {
      return existing; // уже опубликовано (например create() уже сделал это) — идемпотентно, не ошибка
    }
    if (existing.status !== ListingStatus.DRAFT) {
      throw Object.assign(new Error('Только черновики можно опубликовать'), { statusCode: 400 });
    }

    const settings = await this.prisma.siteSettings.findUnique({ where: { id: 'singleton' } });
    const isAutoModerated = settings?.autoModerationEnabled === true;

    const updated = await this.prisma.listing.update({
      where: { id },
      data: {
        status: ListingStatus.ACTIVE,
        moderationStatus: isAutoModerated ? ModerationStatus.APPROVED : ModerationStatus.PENDING,
      },
    });

    this.invalidateCatalogCache().catch(() => {});
    return updated;
  }

  /**
   * Продвижение объявления (Boost/VIP)
   */
  async promote(
    listingId: string,
    ownerId: string,
    tier: 'BASIC' | 'TOP' | 'URGENT',
    days: number,
  ): Promise<Listing> {
    const settings = await this.prisma.siteSettings.findUnique({ where: { id: 'singleton' } });
    if (settings && settings.vipBoostEnabled === false) {
      throw Object.assign(new Error('Функция VIP-продвижения временно недоступна'), { statusCode: 503 });
    }

    const listing = await this.prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw Object.assign(new Error('Listing not found'), { statusCode: 404 });
    if (listing.ownerId !== ownerId) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });

    const tierPrices: Record<string, number> = {
      BASIC: 50000,
      TOP: 120000,
      URGENT: 90000,
    };

    const promotedUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const [updatedListing] = await this.prisma.$transaction([
      this.prisma.listing.update({
        where: { id: listingId },
        data: {
          isPromoted: true,
          promotedUntil,
          promotionTier: tier,
        },
      }),
      this.prisma.promotionPurchase.create({
        data: {
          listingId,
          buyerId: ownerId,
          tier,
          amount: tierPrices[tier] || 50000,
          currency: 'UZS',
          status: 'PAID', // В текущей версии промо выдаётся администратором/ручно как PAID до интеграции онлайн-эквайринга
          paidAt: new Date(),
        },
      }),
    ]);

    return updatedListing;
  }

  /**
   * Похожие объявления рядом (в том же городе/районе и ценовом диапазоне ±30%)
   */
  async getSimilar(id: string, limit = 6) {
    const listing = await this.prisma.listing.findUnique({ where: { id } });
    if (!listing) throw Object.assign(new Error('Listing not found'), { statusCode: 404 });

    const numericPrice = Number(listing.price);
    const minPrice = numericPrice * 0.7;
    const maxPrice = numericPrice * 1.3;

    return this.prisma.listing.findMany({
      where: {
        id: { not: listing.id },
        city: listing.city,
        ...(listing.district ? { district: listing.district } : {}),
        status: ListingStatus.ACTIVE,
        moderationStatus: ModerationStatus.APPROVED,
        price: { gte: minPrice, lte: maxPrice },
      },
      take: limit,
      orderBy: [{ isPromoted: 'desc' }, { createdAt: 'desc' }],
      include: {
        images: { select: { id: true, url: true, mimeType: true } },
        owner: { select: { id: true, name: true, avatar: true } },
        _count: { select: { favorites: true } },
      },
    });
  }

  /**
   * Отправить жалобу на объявление
   */
  async createReport(
    listingId: string,
    reporterId: string | null,
    reason: 'SCAM' | 'ALREADY_RENTED' | 'WRONG_PRICE' | 'WRONG_PHOTOS' | 'DUPLICATE' | 'REALTOR' | 'OTHER',
    comment?: string,
  ) {
    const listing = await this.prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw Object.assign(new Error('Listing not found'), { statusCode: 404 });

    const report = await this.prisma.listingReport.create({
      data: {
        listingId,
        reporterId,
        reason,
        comment,
      },
    });

    await this.prisma.adminNotification.create({
      data: {
        type: 'LISTING_REPORT',
        title: 'Новая жалоба на объявление',
        message: `Жалоба (${reason}) на объявление "${listing.title}". ${comment || ''}`,
        link: `/listings/${listingId}`,
      },
    });

    return report;
  }

  /**
   * AI и статистическая оценка справедливой цены аренды
   */
  async estimateFairPrice(input: {
    city: string;
    district?: string;
    rooms: number;
    area: number;
    type: string;
  }) {
    const comparables = await this.prisma.listing.findMany({
      where: {
        city: { contains: input.city, mode: 'insensitive' },
        ...(input.district ? { district: { contains: input.district, mode: 'insensitive' } } : {}),
        rooms: input.rooms,
        status: ListingStatus.ACTIVE,
        moderationStatus: ModerationStatus.APPROVED,
        area: {
          gte: input.area * 0.75,
          lte: input.area * 1.25,
        },
      },
      select: { price: true },
      take: 50,
    });

    if (comparables.length < 2) {
      return {
        min: null,
        max: null,
        average: null,
        confidence: 'low',
        sampleSize: comparables.length,
      };
    }

    const prices = comparables.map((c) => Number(c.price)).sort((a, b) => a - b);
    const p25 = prices[Math.floor(prices.length * 0.25)];
    const p75 = prices[Math.floor(prices.length * 0.75)];
    const avg = Math.round(prices.reduce((sum, p) => sum + p, 0) / prices.length);

    return {
      min: p25,
      max: p75,
      average: avg,
      confidence: comparables.length >= 10 ? 'high' : 'medium',
      sampleSize: comparables.length,
    };
  }

  /**
   * Курсорная пагинация (по createdAt + id) для высокой производительности на больших смещениях
   */
  async findManyCursor(cursor?: string, limit = 20) {
    const items = await this.prisma.listing.findMany({
      take: limit + 1,
      where: {
        status: ListingStatus.ACTIVE,
        moderationStatus: ModerationStatus.APPROVED,
      },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        images: { select: { id: true, url: true, mimeType: true } },
        owner: { select: { id: true, name: true, avatar: true } },
      },
    });

    const hasMore = items.length > limit;
    const pageItems = hasMore ? items.slice(0, -1) : items;
    const nextCursor = hasMore && pageItems.length > 0 ? pageItems[pageItems.length - 1].id : null;

    return { items: pageItems, nextCursor };
  }

  /**
   * История изменения цены объявления
   */
  async getPriceHistory(listingId: string) {
    return this.prisma.priceHistory.findMany({
      where: { listingId },
      orderBy: { changedAt: 'asc' },
    });
  }
}
