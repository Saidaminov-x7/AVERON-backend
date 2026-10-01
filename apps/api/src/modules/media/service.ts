// apps/api/src/modules/media/service.ts

import { PrismaClient, Media } from '@prisma/client';
import { createHash } from 'crypto';
import { fileTypeFromBuffer } from 'file-type';
import { config } from '../../config';
import { ALLOWED_MIME_TYPES } from './schemas';
import { createStorageAdapter, IStorageAdapter } from './storage';

import { FastifyBaseLogger } from 'fastify';

export interface UploadedFile {
  filename: string;
  mimetype: string;
  data: Buffer;
}

export interface MediaWithThumbnail extends Media {
  thumbnailUrl?: string;
}

export class MediaService {
  private readonly storage: IStorageAdapter;

  constructor(
    private readonly prisma: PrismaClient,
    storageAdapter?: IStorageAdapter,
    logger?: FastifyBaseLogger,
  ) {
    this.storage = storageAdapter ?? createStorageAdapter(logger);
  }

  /**
   * Загрузить изображение: валидация → сохранение через StorageAdapter → запись в БД.
   */
  async upload(
    file: UploadedFile,
    ownerId: string,
    listingId?: string,
    isAdmin = false,
    maxFileSizeBytes = config.MAX_FILE_SIZE,
  ): Promise<Media & { isNewUpload: boolean }> {
    const { data, filename } = file;

    // 1. Проверяем сигнатуру (magic bytes) реального содержимого
    const detected = await fileTypeFromBuffer(data);
    const isSvg = file.mimetype === 'image/svg+xml' || data.slice(0, 200).toString('utf-8').includes('<svg');
    let mimetype: string = detected?.mime || file.mimetype || 'image/png';
    if (!detected || !ALLOWED_MIME_TYPES.includes(detected.mime as (typeof ALLOWED_MIME_TYPES)[number])) {
      if (isSvg) {
        mimetype = 'image/svg+xml';
      } else {
        throw Object.assign(
          new Error(`Unsupported file type: ${detected?.mime || 'unknown'}. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`),
          { statusCode: 415 },
        );
      }
    }

    // 2. Проверяем размер
    if (data.length > maxFileSizeBytes) {
      throw Object.assign(
        new Error(`File too large. Max size: ${maxFileSizeBytes / 1024 / 1024}MB`),
        { statusCode: 413 },
      );
    }

    // 3. IDOR проверка: если указан listingId, проверяем, что объявление принадлежит пользователю
    if (listingId) {
      const listing = await this.prisma.listing.findUnique({ where: { id: listingId } });
      if (!listing) {
        throw Object.assign(new Error('Listing not found'), { statusCode: 404 });
      }
      if (!isAdmin && listing.ownerId !== ownerId) {
        throw Object.assign(new Error('Forbidden: You do not own this listing'), { statusCode: 403 });
      }
      const settings = await this.prisma.siteSettings.findUnique({ where: { id: 'singleton' }, select: { maxImagesPerListing: true } });
      const imageCount = await this.prisma.media.count({ where: { listingId } });
      if (imageCount >= (settings?.maxImagesPerListing ?? 10)) {
        throw Object.assign(new Error(`Maximum ${settings?.maxImagesPerListing ?? 10} images per listing`), { statusCode: 400 });
      }
    }

    // 4. Вычисляем SHA-256 хэш исходного файла (для дедупликации)
    const hash = createHash('sha256').update(data).digest('hex');

    // 5. Проверяем дедупликацию в базе данных
    const existing = await this.prisma.media.findUnique({ where: { hash } });
    if (existing) {
      if (listingId && existing.listingId !== listingId) {
        const updated = await this.prisma.media.update({
          where: { id: existing.id },
          data: { listingId },
        });
        return { ...updated, isNewUpload: false };
      }
      return { ...existing, isNewUpload: false };
    }

    // 6. Сохраняем файл через выбранный адаптер (Local или Cloudinary)
    const uploadResult = await this.storage.upload({
      filename,
      mimetype,
      data,
      hash,
    });

    // 7. Записываем метаданные в БД
    const created = await this.prisma.media.create({
      data: {
        url: uploadResult.url,
        ownerId,
        listingId,
        mimeType: uploadResult.mimeType,
        size: uploadResult.size,
        width: uploadResult.width,
        height: uploadResult.height,
        hash,
      },
    });
    return { ...created, isNewUpload: true };
  }

  /**
   * Удалить медиафайл (только владелец или ADMIN)
   */
  async delete(id: string, ownerId: string, isAdmin = false, onlyIfUnattached = false): Promise<void> {
    const media = await this.prisma.media.findUnique({ where: { id } });
    if (!media) throw Object.assign(new Error('Media not found'), { statusCode: 404 });
    if (!isAdmin && media.ownerId !== ownerId) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }
    const productImageReferences = await this.prisma.commerceProductImage.count({ where: { mediaId: id } });
    if (productImageReferences > 0) {
      throw Object.assign(new Error('Media is still in use by a product'), { statusCode: 409 });
    }
    if (onlyIfUnattached && media.listingId) {
      throw Object.assign(new Error('Media is still attached to a listing'), { statusCode: 409 });
    }

    // Удаляем из хранилища (Local или Cloudinary)
    await this.storage.delete(media.url);

    // Удаляем запись из БД
    await this.prisma.media.delete({ where: { id } });
  }

  /**
   * Получить медиафайлы объявления
   */
  async getListingMedia(listingId: string): Promise<MediaWithThumbnail[]> {
    const items = await this.prisma.media.findMany({
      where: { listingId },
      orderBy: { createdAt: 'asc' },
    });
    return items.map((item) => ({
      ...item,
      thumbnailUrl: this.storage.getTransformedUrl
        ? this.storage.getTransformedUrl(item.url, { width: 400 })
        : item.url,
    }));
  }

  /**
   * Привязать медиафайл к объявлению с IDOR проверкой
   */
  async attachToListing(
    mediaId: string,
    listingId: string,
    ownerId: string,
    isAdmin = false,
  ): Promise<Media> {
    const media = await this.prisma.media.findUnique({ where: { id: mediaId } });
    if (!media) throw Object.assign(new Error('Media not found'), { statusCode: 404 });
    if (!isAdmin && media.ownerId !== ownerId) {
      throw Object.assign(new Error('Forbidden: You do not own this media'), { statusCode: 403 });
    }

    const listing = await this.prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw Object.assign(new Error('Listing not found'), { statusCode: 404 });
    if (!isAdmin && listing.ownerId !== ownerId) {
      throw Object.assign(new Error('Forbidden: You do not own this listing'), { statusCode: 403 });
    }

    return this.prisma.media.update({
      where: { id: mediaId },
      data: { listingId },
    });
  }

  /**
   * Получить список всех медиафайлов (для админ-панели и медиа-библиотеки)
   */
  async list(query: { page?: number; limit?: number; mimeType?: string } = {}) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 100) : 24;
    const skip = (page - 1) * limit;
    const where = query.mimeType ? { mimeType: { startsWith: query.mimeType } } : {};
    const [rawItems, total, storage] = await this.prisma.$transaction([
      this.prisma.media.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.media.count({ where }),
      this.prisma.media.aggregate({ where, _sum: { size: true } }),
    ]);

    const items: MediaWithThumbnail[] = rawItems.map((item) => ({
      ...item,
      thumbnailUrl: this.storage.getTransformedUrl
        ? this.storage.getTransformedUrl(item.url, { width: 400 })
        : item.url,
    }));

    return {
      items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        totalBytes: storage._sum.size ?? 0,
      },
    };
  }

  /**
   * @deprecated используйте list()
   */
  async listAll(page = 1, limit = 24, mimeType?: string) {
    return this.list({ page, limit, mimeType });
  }
}
