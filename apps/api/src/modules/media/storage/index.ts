// apps/api/src/modules/media/storage/index.ts

import { IStorageAdapter } from './storage.interface';
import { LocalStorageAdapter } from './local.adapter';
import { CloudinaryStorageAdapter } from './cloudinary.adapter';
import { config } from '../../../config';
import { FastifyBaseLogger } from 'fastify';

export * from './storage.interface';
export * from './local.adapter';
export * from './cloudinary.adapter';

/**
 * Фабрика хранилища: возвращает адаптер согласно переменной STORAGE_DRIVER
 * либо автоматически активирует Cloudinary при наличии заданных ключей
 */
export function createStorageAdapter(logger?: FastifyBaseLogger): IStorageAdapter {
  const hasCloudinaryKeys = Boolean(
    config.CLOUDINARY_CLOUD_NAME &&
    config.CLOUDINARY_API_KEY &&
    config.CLOUDINARY_API_SECRET
  );

  if (config.STORAGE_DRIVER === 'cloudinary' || hasCloudinaryKeys) {
    if (logger) {
      logger.info(
        { cloudName: config.CLOUDINARY_CLOUD_NAME, folder: config.CLOUDINARY_FOLDER },
        '[Storage] Using Cloudinary storage adapter',
      );
    }
    return new CloudinaryStorageAdapter(logger);
  }

  if (logger) {
    logger.info({ path: config.STORAGE_PATH }, '[Storage] Using Local storage adapter');
  }
  return new LocalStorageAdapter(config.STORAGE_PATH, logger);
}
