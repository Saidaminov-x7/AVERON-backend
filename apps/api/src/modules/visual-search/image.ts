import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { VisualSearchError } from './errors';

const supportedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_IMAGE_DIMENSION = 8_000;

function hasCompleteImageContainer(data: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/jpeg') {
    return data.length >= 4
      && data[0] === 0xff
      && data[1] === 0xd8
      && data[data.length - 2] === 0xff
      && data[data.length - 1] === 0xd9;
  }

  if (mimeType === 'image/png') {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const endChunk = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    if (!data.subarray(0, signature.length).equals(signature)) return false;

    let offset = signature.length;
    while (offset + 12 <= data.length) {
      const length = data.readUInt32BE(offset);
      const chunkEnd = offset + 12 + length;
      if (chunkEnd > data.length) return false;
      if (data.toString('ascii', offset + 4, offset + 8) === 'IEND') {
        return length === 0 && chunkEnd === data.length && data.subarray(offset, chunkEnd).equals(endChunk);
      }
      offset = chunkEnd;
    }
    return false;
  }

  if (mimeType === 'image/webp') {
    return data.length >= 12
      && data.toString('ascii', 0, 4) === 'RIFF'
      && data.toString('ascii', 8, 12) === 'WEBP'
      && data.readUInt32LE(4) === data.length - 8;
  }

  return false;
}

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
  if (!hasCompleteImageContainer(data, declaredMimeType)) {
    throw new VisualSearchError('IMAGE_INVALID');
  }

  let detected: { mime: string } | undefined;
  try {
    detected = await fileTypeFromBuffer(data);
  } catch {
    detected = undefined;
  }
  if (!detected || detected.mime !== declaredMimeType || !supportedMimeTypes.has(detected.mime)) {
    throw new VisualSearchError('IMAGE_INVALID');
  }

  try {
    const metadata = await sharp(data, {
      limitInputPixels: false,
      animated: false,
      failOn: 'error',
    }).metadata();
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

    const { data: normalized, info } = await sharp(data, {
      limitInputPixels: MAX_IMAGE_PIXELS,
      animated: false,
      failOn: 'error',
    })
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
