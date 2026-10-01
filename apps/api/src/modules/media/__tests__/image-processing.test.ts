import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { processUploadedImage } from '../image-processing';

async function image(format: 'jpeg' | 'png' | 'webp') {
  return sharp({
    create: { width: 20, height: 12, channels: 3, background: { r: 40, g: 50, b: 60 } },
  })[format]().toBuffer();
}

describe('media image processing', () => {
  it.each(['jpeg', 'png', 'webp'] as const)('decodes and normalizes %s uploads', async (format) => {
    const input = await image(format);
    const processed = await processUploadedImage(input);
    const metadata = await sharp(processed.data).metadata();
    expect(metadata.format).toBe('webp');
    expect(processed.width).toBe(20);
    expect(processed.height).toBe(12);
  });

  it('rejects malformed images without passing them to storage', async () => {
    await expect(processUploadedImage(Buffer.from('not an image')))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects images that exceed the dimension limit', async () => {
    const tooWide = await sharp({
      create: { width: 8_001, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).jpeg().toBuffer();
    await expect(processUploadedImage(tooWide)).rejects.toMatchObject({ statusCode: 400 });
  });
});
