// apps/api/src/modules/admin/fraudDetection.service.ts
import { PrismaClient } from '@prisma/client';

export interface FraudAnalysisResult {
  score: number; // 0 to 100
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  factors: Array<{
    code: string;
    description: string;
    weight: number;
  }>;
  possibleDuplicates: Array<{
    id: string;
    title: string;
    similarity: number; // percentage
    ownerId: string;
  }>;
  marketFairPrice: {
    medianPrice: number;
    differencePercent: number;
    verdict: 'UNDERPRICED' | 'FAIR' | 'OVERPRICED';
  };
}

export class FraudDetectionService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Вычисляет Fraud Score, проверяет дубликаты и сравнивает цену со справедливой рыночной ценой
   */
  async analyzeListing(listingId: string): Promise<FraudAnalysisResult> {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      include: {
        owner: true,
        images: true,
      },
    });

    if (!listing) {
      throw Object.assign(new Error('Listing not found'), { statusCode: 404 });
    }

    let score = 0;
    const factors: FraudAnalysisResult['factors'] = [];

    // 1. Проверка верификации владельца
    if (!listing.owner.verified) {
      score += 20;
      factors.push({
        code: 'UNVERIFIED_OWNER',
        description: 'Владелец аккаунта не подтвердил номер телефона/документы',
        weight: 20,
      });
    }

    // 2. Проверка даты создания аккаунта (< 24 часов)
    const accountAgeHours = (Date.now() - new Date(listing.owner.createdAt).getTime()) / (1000 * 60 * 60);
    if (accountAgeHours < 24) {
      score += 25;
      factors.push({
        code: 'NEW_ACCOUNT',
        description: 'Аккаунт автора создан менее 24 часов назад',
        weight: 25,
      });
    }

    // 3. Анализ описания на ключевые слова мошенников
    const suspiciousKeywords = [
      'предоплат', 'карт', 'карту', 'перевод', 'депозит срочн', 'залог до просмотр', 
      'бронь без просмотр', 'telegram @', 'только в телеграм', 'не звонить',
      'сдаю срочно в связи с отъездом', 'дешево так как уезжаю', 'click', 'payme'
    ];
    const descLower = (listing.description || '').toLowerCase() + ' ' + listing.title.toLowerCase();
    const matchedKeywords = suspiciousKeywords.filter((kw) => descLower.includes(kw));

    if (matchedKeywords.length > 0) {
      const kwWeight = Math.min(35, matchedKeywords.length * 15);
      score += kwWeight;
      factors.push({
        code: 'SUSPICIOUS_KEYWORDS',
        description: `Обнаружены подозрительные фразы: ${matchedKeywords.join(', ')}`,
        weight: kwWeight,
      });
    }

    // 4. Проверка количества фото
    if (!listing.images || listing.images.length === 0) {
      score += 20;
      factors.push({
        code: 'NO_PHOTOS',
        description: 'В объявлении отсутствуют фотографии',
        weight: 20,
      });
    } else if (listing.images.length === 1) {
      score += 10;
      factors.push({
        code: 'SINGLE_PHOTO',
        description: 'Загружена всего 1 фотография',
        weight: 10,
      });
    }

    // 5. Оценка справедливой цены (Fair Price) по району и комнатности
    const similarListings = await this.prisma.listing.findMany({
      where: {
        city: listing.city,
        district: listing.district,
        rooms: listing.rooms,
        id: { not: listing.id },
        moderationStatus: 'APPROVED',
        status: 'ACTIVE',
      },
      select: { price: true },
      take: 50,
    });

    let medianPrice = Number(listing.price);
    let diffPercent = 0;
    let priceVerdict: 'UNDERPRICED' | 'FAIR' | 'OVERPRICED' = 'FAIR';

    if (similarListings.length >= 3) {
      const prices = similarListings.map((l) => Number(l.price)).sort((a, b) => a - b);
      medianPrice = prices[Math.floor(prices.length / 2)];
      const currentPrice = Number(listing.price);

      if (medianPrice > 0) {
        diffPercent = Math.round(((currentPrice - medianPrice) / medianPrice) * 100);
      }

      if (diffPercent <= -35) {
        priceVerdict = 'UNDERPRICED';
        score += 30;
        factors.push({
          code: 'SUSPICIOUSLY_LOW_PRICE',
          description: `Цена на ${Math.abs(diffPercent)}% ниже медианной цены по району ($${medianPrice.toLocaleString()})`,
          weight: 30,
        });
      } else if (diffPercent >= 50) {
        priceVerdict = 'OVERPRICED';
      }
    }

    // 6. Поиск возможных дубликатов
    const titleWords = listing.title.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const possibleCandidates = await this.prisma.listing.findMany({
      where: {
        city: listing.city,
        rooms: listing.rooms,
        id: { not: listing.id },
      },
      select: {
        id: true,
        title: true,
        description: true,
        ownerId: true,
        price: true,
      },
      take: 20,
    });

    const possibleDuplicates: FraudAnalysisResult['possibleDuplicates'] = [];

    for (const candidate of possibleCandidates) {
      let matchCount = 0;
      for (const word of titleWords) {
        if (candidate.title.toLowerCase().includes(word)) {
          matchCount++;
        }
      }
      const similarity = titleWords.length > 0 ? Math.round((matchCount / titleWords.length) * 100) : 0;
      if (similarity >= 60) {
        possibleDuplicates.push({
          id: candidate.id,
          title: candidate.title,
          similarity,
          ownerId: candidate.ownerId,
        });
      }
    }

    if (possibleDuplicates.length > 0) {
      score += 25;
      factors.push({
        code: 'DUPLICATE_SUSPECT',
        description: `Найдено похожих объявлений: ${possibleDuplicates.length}`,
        weight: 25,
      });
    }

    // Нормализация скора 0-100
    const finalScore = Math.min(100, Math.max(0, score));
    const riskLevel: FraudAnalysisResult['riskLevel'] =
      finalScore >= 75 ? 'CRITICAL' : finalScore >= 50 ? 'HIGH' : finalScore >= 25 ? 'MEDIUM' : 'LOW';

    return {
      score: finalScore,
      riskLevel,
      factors,
      possibleDuplicates,
      marketFairPrice: {
        medianPrice,
        differencePercent: diffPercent,
        verdict: priceVerdict,
      },
    };
  }
}
