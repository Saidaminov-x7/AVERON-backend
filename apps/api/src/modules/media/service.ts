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

export type MediaWithThumbnail = Omit<Media, 'listingId'> & {
  thumbnailUrl?: string;
};

function withoutLegacyListingId(media: Media): Omit<Media, 'listingId'> {
  const currentMedia = { ...media };
  Reflect.deleteProperty(currentMedia, 'listingId');
  return currentMedia;
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
    maxFileSizeBytes = config.MAX_FILE_SIZE,
  ): Promise<Omit<Media, 'listingId'> & { isNewUpload: boolean }> {
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

    // 4. Вычисляем SHA-256 хэш исходного файла (для дедупликации)
    const hash = createHash('sha256').update(data).digest('hex');

    // 5. Проверяем дедупликацию в базе данных
    const existing = await this.prisma.media.findUnique({ where: { hash } });
    if (existing) {
      return { ...withoutLegacyListingId(existing), isNewUpload: false };
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
        mimeType: uploadResult.mimeType,
        size: uploadResult.size,
        width: uploadResult.width,
        height: uploadResult.height,
        hash,
      },
    });
    return { ...withoutLegacyListingId(created), isNewUpload: true };
  }

  /**
   * Удалить медиафайл (только владелец или ADMIN)
   */
  async delete(id: string, ownerId: string, isAdmin = false): Promise<void> {
    const media = await this.prisma.media.findUnique({ where: { id } });
    if (!media) throw Object.assign(new Error('Media not found'), { statusCode: 404 });
    if (!isAdmin && media.ownerId !== ownerId) {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    }

    const productImageReferences = await this.prisma.commerceProductImage.count({ where: { mediaId: id } });
    if (productImageReferences > 0) {
      throw Object.assign(new Error('Media is still in use by a product'), { statusCode: 409 });
    }
    const reviewMediaReferences = await this.prisma.commerceProductReviewMedia.count({ where: { mediaId: id } });
    if (reviewMediaReferences > 0) {
      throw Object.assign(new Error('Media is still in use by a review'), { statusCode: 409 });
    }
    // Удаляем из хранилища (Local или Cloudinary)
    await this.storage.delete(media.url);

    // Удаляем запись из БД
    await this.prisma.media.delete({ where: { id } });
  }

  async readVerifiedImages(ids: string[]): Promise<Array<{ mimeType: string; data: Buffer }>> {
    if (ids.length < 1 || ids.length > 5) {
      throw Object.assign(new Error('AI_IMAGE_COUNT_INVALID'), { statusCode: 400 });
    }
    const media = await this.prisma.media.findMany({
      where: { id: { in: ids } },
      select: { id: true, url: true, mimeType: true, size: true },
    });
    if (
      media.length !== ids.length ||
      media.reduce((total, item) => total + item.size, 0) > 10 * 1024 * 1024 ||
      media.some(({ mimeType, size }) =>
        !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType) ||
        size < 1 ||
        size > 10 * 1024 * 1024)
    ) {
      throw Object.assign(new Error('AI_IMAGE_MEDIA_INVALID'), { statusCode: 400 });
    }
    const results = await Promise.all(media.map(async ({ url, mimeType }) => {
      const data = await this.storage.read(url);
      const detected = await fileTypeFromBuffer(data);
      if (!detected || detected.mime !== mimeType || data.length > 10 * 1024 * 1024) {
        throw Object.assign(new Error('AI_IMAGE_MEDIA_INVALID'), { statusCode: 400 });
      }
      return { mimeType, data };
    }));
    return ids.map((id) => results[media.findIndex((item) => item.id === id)]);
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
        select: {
          id: true,
          url: true,
          ownerId: true,
          mimeType: true,
          size: true,
          width: true,
          height: true,
          hash: true,
          createdAt: true,
        },
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
