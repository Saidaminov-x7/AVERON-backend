import FileType from 'file-type';
import sharp from 'sharp';
import { VisualSearchError } from './errors';

const supportedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_IMAGE_DIMENSION = 8_000;

export interface NormalizedImage {
  data: Buffer;
  width: number;
  height: number;
}

export async function normalizeUploadedImage(
  data: Buffer,
  declaredMimeType: string,
): Promise<NormalizedImage> {
  if (!supportedMimeTypes.has(declaredMimeType)) {
    throw new VisualSearchError('IMAGE_UNSUPPORTED');
  }

  let detected: { mime: string } | undefined;
  try {
    detected = await FileType.fromBuffer(data);
  } catch {
    detected = undefined;
  }
  if (!detected || detected.mime !== declaredMimeType || !supportedMimeTypes.has(detected.mime)) {
    throw new VisualSearchError('IMAGE_INVALID');
  }

  try {
    const decoder = sharp(data, {
      limitInputPixels: MAX_IMAGE_PIXELS,
      animated: false,
      failOn: 'error',
    });
    const metadata = await decoder.metadata();
    if (
      !metadata.width
      || !metadata.height
      || metadata.width > MAX_IMAGE_DIMENSION
      || metadata.height > MAX_IMAGE_DIMENSION
      || metadata.width * metadata.height > MAX_IMAGE_PIXELS
      || !['jpeg', 'png', 'webp'].includes(metadata.format ?? '')
    ) {
      throw new VisualSearchError('IMAGE_UNSUPPORTED');
    }

    const { data: normalized, info } = await decoder
      .rotate()
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { data: normalized, width: info.width, height: info.height };
  } catch (error) {
    if (error instanceof VisualSearchError) throw error;
    throw new VisualSearchError('IMAGE_INVALID');
  }
}
