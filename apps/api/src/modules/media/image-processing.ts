import sharp from 'sharp';

const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_IMAGE_DIMENSION = 8_000;
const SUPPORTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'svg']);

export async function processUploadedImage(data: Buffer) {
  try {
    const image = sharp(data, {
      limitInputPixels: MAX_IMAGE_PIXELS,
      animated: false,
      failOn: 'error',
    });
    const metadata = await image.metadata();
    if (
      !metadata.width
      || !metadata.height
      || metadata.width > MAX_IMAGE_DIMENSION
      || metadata.height > MAX_IMAGE_DIMENSION
      || metadata.width * metadata.height > MAX_IMAGE_PIXELS
      || !SUPPORTED_FORMATS.has(metadata.format ?? '')
    ) {
      throw new Error('Invalid image dimensions or format');
    }

    const optimized = await image
      .rotate()
      .resize({
        width: 1920,
        height: 1080,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 85 })
      .toBuffer();
    return {
      data: optimized,
      width: metadata.width,
      height: metadata.height,
    };
  } catch {
    throw Object.assign(new Error('Invalid or unsupported image'), { statusCode: 400 });
  }
}
