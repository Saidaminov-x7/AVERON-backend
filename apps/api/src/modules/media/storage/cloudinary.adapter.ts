// apps/api/src/modules/media/storage/cloudinary.adapter.ts

import { IStorageAdapter, StorageUploadResult } from './storage.interface';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { config } from '../../../config';
import { FastifyBaseLogger } from 'fastify';
import { processUploadedImage } from '../image-processing';

/**
 * Облачный адаптер Cloudinary (S3-совместимое медиахранилище для Production)
 */
export class CloudinaryStorageAdapter implements IStorageAdapter {
  constructor(private readonly logger?: FastifyBaseLogger) {
    if (!config.CLOUDINARY_CLOUD_NAME || !config.CLOUDINARY_API_KEY || !config.CLOUDINARY_API_SECRET) {
      throw new Error(
        'Cloudinary adapter requires CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET environment variables',
      );
    }

    cloudinary.config({
      cloud_name: config.CLOUDINARY_CLOUD_NAME,
      api_key: config.CLOUDINARY_API_KEY,
      api_secret: config.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }

  async upload(file: {
    filename: string;
    mimetype: string;
    data: Buffer;
    hash: string;
  }): Promise<StorageUploadResult> {
    const startTime = Date.now();
    const folder = config.CLOUDINARY_FOLDER || 'averon/products';
    const publicId = file.hash.slice(0, 32);

    // 1. Клиентская пред-оптимизация через sharp перед загрузкой в облако
    const { data: optimized, width, height } = await processUploadedImage(file.data);

    // 2. Потоковая загрузка в Cloudinary с логированием
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: 'image',
          format: 'webp',
          public_id: publicId,
        },
        (error, result: UploadApiResponse | undefined) => {
          const durationMs = Date.now() - startTime;
          if (error || !result) {
            let reason: 'auth' | 'quota' | 'network' | 'unknown' = 'unknown';
            const msg = error?.message?.toLowerCase() || '';
            if (msg.includes('invalid api') || msg.includes('unauthorized') || msg.includes('must supply api_key')) {
              reason = 'auth';
            } else if (msg.includes('quota') || msg.includes('limit') || msg.includes('rate limit')) {
              reason = 'quota';
            } else if (msg.includes('timeout') || msg.includes('network') || msg.includes('econnrefused') || msg.includes('enotfound')) {
              reason = 'network';
            }

            if (this.logger) {
              this.logger.error(
                {
                  err: error,
                  filename: file.filename,
                  folder,
                  publicId,
                  reason,
                  durationMs,
                },
                '[CloudinaryStorageAdapter] Upload failed',
              );
            }
            return reject(
              new Error(`Cloudinary upload failed (${reason}): ${error?.message || 'Unknown error'}`),
            );
          }

          if (this.logger) {
            this.logger.info(
              {
                url: result.secure_url,
                publicId: result.public_id,
                size: result.bytes || optimized.length,
                durationMs,
              },
              '[CloudinaryStorageAdapter] Upload successful',
            );
          }

          resolve({
            url: result.secure_url,
            key: result.public_id,
            mimeType: 'image/webp',
            size: result.bytes || optimized.length,
            width: result.width || width,
            height: result.height || height,
          });
        },
      );

      uploadStream.end(optimized);
    });
  }

  /**
   * Строит URL с Cloudinary-трансформацией на лету, без повторной загрузки.
   */
  getTransformedUrl(publicIdOrUrl: string, opts: { width?: number; height?: number; crop?: string } = { width: 400 }): string {
    const publicId = this.extractPublicId(publicIdOrUrl);
    return cloudinary.url(publicId, {
      secure: true,
      transformation: [
        {
          width: opts.width || 400,
          height: opts.height,
          crop: opts.crop || 'fill',
          quality: 'auto',
          fetch_format: 'auto',
        },
      ],
    });
  }

  /**
   * Извлекает public_id из полного Cloudinary URL или оставляет ключ как есть
   */
  private extractPublicId(keyOrUrl: string): string {
    if (!keyOrUrl.startsWith('http://') && !keyOrUrl.startsWith('https://')) {
      return keyOrUrl;
    }
    try {
      const url = new URL(keyOrUrl);
      // Путь вида /<cloud_name>/image/upload/(v<version>/)?<folder>/<publicId>.<ext>
      const pathname = url.pathname;
      const uploadIdx = pathname.indexOf('/upload/');
      if (uploadIdx === -1) return keyOrUrl;
      
      let afterUpload = pathname.substring(uploadIdx + '/upload/'.length);
      // Убираем версию если есть (v1234567890/)
      afterUpload = afterUpload.replace(/^v\d+\//, '');
      // Убираем расширение (.webp, .jpg и т.д.)
      const lastDotIdx = afterUpload.lastIndexOf('.');
      if (lastDotIdx !== -1) {
        afterUpload = afterUpload.substring(0, lastDotIdx);
      }
      return afterUpload;
    } catch {
      return keyOrUrl;
    }
  }

  async delete(keyOrUrl: string): Promise<void> {
    const publicId = this.extractPublicId(keyOrUrl);
    try {
      const result = await cloudinary.uploader.destroy(publicId);
      if (this.logger) {
        this.logger.info({ publicId, keyOrUrl, result }, '[CloudinaryStorageAdapter] File deleted');
      }
    } catch (err) {
      const error = err as Error;
      if (this.logger) {
        this.logger.warn({ err: error.message, publicId, keyOrUrl }, '[CloudinaryStorageAdapter] Failed to delete file');
      }
    }
  }
}
