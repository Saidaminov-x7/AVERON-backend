import { IStorageAdapter, StorageUploadResult } from './storage.interface';
import { join, relative, resolve, isAbsolute, sep } from 'path';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { config } from '../../../config';
import { FastifyBaseLogger } from 'fastify';
import { processUploadedImage } from '../image-processing';

/**
 * Локальный файловый адаптер (диск /tmp/uploads или подключенный Railway Volume)
 */
export class LocalStorageAdapter implements IStorageAdapter {
  constructor(
    private readonly storagePath: string = config.STORAGE_PATH,
    private readonly logger?: FastifyBaseLogger,
  ) {}

  async upload(file: {
    filename: string;
    mimetype: string;
    data: Buffer;
    hash: string;
  }): Promise<StorageUploadResult> {
    const { data: optimized, width, height } = await processUploadedImage(file.data);

    const fileName = `${randomUUID()}.webp`;
    const yearMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    const subDir = join(this.storagePath, yearMonth);

    if (!existsSync(subDir)) {
      await mkdir(subDir, { recursive: true });
    }

    const filePath = join(subDir, fileName);
    await writeFile(filePath, optimized);

    // URL для обслуживания через @fastify/static (/uploads/...)
    const url = `/uploads/${yearMonth}/${fileName}`;
    const key = `${yearMonth}/${fileName}`;

    return {
      url,
      key,
      mimeType: 'image/webp',
      size: optimized.length,
      width,
      height,
    };
  }

  async delete(key: string): Promise<void> {
    try {
      const sanitizedKey = key.replace(/^\/?uploads\//, '');
      const fullPath = join(this.storagePath, sanitizedKey);
      const resolvedPath = resolve(fullPath);
      const resolvedStoragePath = resolve(this.storagePath);
      
      // Проверка на path traversal: итоговый путь должен начинаться с storagePath
      const relativePath = relative(resolvedStoragePath, resolvedPath);
      if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        if (this.logger) {
          this.logger.warn({ key }, '[LocalStorageAdapter] Path traversal attempt detected');
        }
        return;
      }
      
      if (existsSync(fullPath)) {
        await unlink(fullPath);
      }
    } catch (err) {
      // Ошибка удаления файла не должна блокировать удаление из БД
      if (this.logger) {
        this.logger.warn({ err, key }, '[LocalStorageAdapter] Failed to delete file');
      }
    }
  }

  getTransformedUrl(publicIdOrUrl: string): string {
    return publicIdOrUrl;
  }
}
