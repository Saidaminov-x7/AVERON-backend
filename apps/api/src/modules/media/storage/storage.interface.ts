// apps/api/src/modules/media/storage/storage.interface.ts

/**
 * Результат сохранения файла через адаптер хранилища
 */
export interface StorageUploadResult {
  url: string;        // Публичный URL для доступа к файлу
  key: string;        // Уникальный идентификатор/путь в хранилище для последующего удаления
  mimeType: string;   // MIME-тип (например, 'image/webp')
  size: number;       // Размер в байтах
  width?: number;     // Ширина в пикселях
  height?: number;    // Высота в пикселях
}

/**
 * Интерфейс абстрактного хранилища медиафайлов
 */
export interface IStorageAdapter {
  /**
   * Загрузка и оптимизация файла
   */
  upload(file: {
    filename: string;
    mimetype: string;
    data: Buffer;
    hash: string;
  }): Promise<StorageUploadResult>;

  /**
   * Удаление файла из хранилища по ключу или URL
   */
  delete(key: string): Promise<void>;

  read(url: string): Promise<Buffer>;

  /**
   * Строит URL с трансформацией (для Cloudinary) или возвращает исходный
   */
  getTransformedUrl?(publicIdOrUrl: string, opts?: { width?: number; height?: number; crop?: string }): string;
}
