// apps/api/src/modules/media/index.ts

import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import FileType from 'file-type';
import { authMiddleware } from '../../lib/authMiddleware';
import { adminMiddleware } from '../../lib/adminMiddleware';
import { MediaService } from './service';
import { uploadQuerySchema, mediaListQuerySchema } from './schemas';

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const HARD_MAX_PRODUCT_PHOTO_SIZE_BYTES = 25 * 1024 * 1024;

async function validateFileType(buffer: Buffer) {
  const detected = await FileType.fromBuffer(buffer);
  if (!detected || !ALLOWED_MIME.includes(detected.mime)) {
    const error = new Error('INVALID_FILE_TYPE: Поддерживаются только изображения (JPEG, PNG, WEBP, GIF)') as Error & { statusCode: number };
    error.statusCode = 400;
    throw error;
  }
}

export const mediaModule: FastifyPluginAsync = async (server) => {
  const getService = (req: FastifyRequest) => new MediaService(req.server.prisma, undefined, req.log);

  /**
   * POST /media/upload — загрузить изображение
   * Content-Type: multipart/form-data
   * Field: file (image)
   * Query: listingId? (UUID)
   */
  server.post('/upload', {
    preHandler: [authMiddleware],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = uploadQuerySchema.parse(request.query);
    const isAdmin = request.user.role === 'ADMIN';
    if (query.purpose === 'productPhoto' && !isAdmin) {
      return reply.status(403).send({ message: 'Only administrators can upload product photos' });
    }
    const settings = query.purpose === 'productPhoto'
      ? await request.server.prisma.siteSettings.findUnique({
          where: { id: 'singleton' },
          select: { maxProductPhotoSizeMb: true },
        })
      : null;
    const maxFileSizeBytes = query.purpose === 'productPhoto'
      ? Math.min(25, settings?.maxProductPhotoSizeMb ?? 10) * 1024 * 1024
      : 10 * 1024 * 1024;

    // Получаем multipart-файл
    const data = await request.file({
      limits: {
        fileSize: query.purpose === 'productPhoto'
          ? HARD_MAX_PRODUCT_PHOTO_SIZE_BYTES
          : maxFileSizeBytes,
      },
    });

    if (!data) {
      return reply.status(400).send({ message: 'No file provided' });
    }

    // Читаем буфер
    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    if (data.file.truncated || buffer.length > maxFileSizeBytes) {
      return reply.status(413).send({ message: `File exceeds the ${Math.floor(maxFileSizeBytes / 1024 / 1024)} MB limit` });
    }

    // Проверяем сигнатуру (magic bytes) файла
    await validateFileType(buffer);

    const service = getService(request);
    try {
      const media = await service.upload(
        { filename: data.filename, mimetype: data.mimetype, data: buffer },
        request.user.userId,
        query.listingId,
        isAdmin,
        maxFileSizeBytes,
      );
      return reply.status(media.isNewUpload ? 201 : 200).send(media);
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      const statusCode = error.statusCode ?? 500;
      if (statusCode >= 500) {
        request.log.error({ err: error }, '[MediaUpload] Failed to upload media');
        return reply.status(500).send({ message: 'Не удалось загрузить файл, попробуйте позже' });
      }
      return reply.status(statusCode).send({ message: error.message });
    }
  });

  /**
   * DELETE /media/:id — удалить медиафайл
   */
  server.delete<{ Params: { id: string } }>('/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const service = getService(request);
    const isAdmin = request.user.role === 'ADMIN';
    const onlyIfUnattached = (request.query as { onlyIfUnattached?: string }).onlyIfUnattached === 'true';
    try {
      await service.delete(request.params.id, request.user.userId, isAdmin, onlyIfUnattached);
      return reply.status(204).send();
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * GET /media/listing/:listingId — медиафайлы объявления
   */
  server.get<{ Params: { listingId: string } }>('/listing/:listingId', async (
    request,
    _reply,
  ) => {
    const service = getService(request);
    const media = await service.getListingMedia(request.params.listingId);
    return media;
  });

  /**
   * PATCH /media/:id/attach — привязать файл к объявлению
   */
  server.patch<{ Params: { id: string }; Body: { listingId: string } }>('/:id/attach', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { listingId } = request.body;
    if (!listingId) {
      return reply.status(400).send({ message: 'listingId is required' });
    }
    const service = getService(request);
    const isAdmin = request.user.role === 'ADMIN';
    try {
      const media = await service.attachToListing(request.params.id, listingId, request.user.userId, isAdmin);
      return media;
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });
  /**
   * GET /media — список всех медиафайлов (для библиотеки и админки)
   */
  server.get('/', {
    preHandler: [adminMiddleware],
  }, async (request: FastifyRequest, _reply: FastifyReply) => {
    const query = mediaListQuerySchema.parse(request.query);
    const service = getService(request);
    return service.list(query);
  });
};
