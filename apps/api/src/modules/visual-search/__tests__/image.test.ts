import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { VisualSearchError } from '../errors';
import { normalizeUploadedImage } from '../image';

describe('visual-search image validation', () => {
  it.each([
    ['JPEG', 'jpeg', 'image/jpeg'],
    ['PNG', 'png', 'image/png'],
    ['WebP', 'webp', 'image/webp'],
  ] as const)('accepts, resizes and re-encodes a supported %s', async (_name, format, mimeType) => {
    const input = await sharp({
      create: { width: 1600, height: 900, channels: 3, background: { r: 20, g: 30, b: 40 } },
    })[format]().toBuffer();

    const normalized = await normalizeUploadedImage(input, mimeType);
    const metadata = await sharp(normalized.data).metadata();

    expect(metadata.format).toBe('jpeg');
    expect(normalized.width).toBeLessThanOrEqual(1024);
    expect(normalized.height).toBeLessThanOrEqual(1024);
  });

  it('rejects unsupported MIME types', async () => {
    await expect(normalizeUploadedImage(Buffer.from('<svg/>'), 'image/svg+xml'))
      .rejects.toMatchObject({ code: 'IMAGE_UNSUPPORTED' });
  });

  it('rejects a MIME declaration that does not match the file signature', async () => {
    const input = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 10, g: 10, b: 10 } },
    }).png().toBuffer();

    await expect(normalizeUploadedImage(input, 'image/jpeg'))
      .rejects.toBeInstanceOf(VisualSearchError);
    await expect(normalizeUploadedImage(input, 'image/jpeg'))
      .rejects.toMatchObject({ code: 'IMAGE_INVALID' });
  });

  it('rejects malformed image bytes', async () => {
    await expect(normalizeUploadedImage(Buffer.from('not-image'), 'image/jpeg'))
      .rejects.toMatchObject({ code: 'IMAGE_INVALID' });
  });

  it('rejects truncated images and excessive dimensions or pixel counts', async () => {
    const valid = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 10, g: 10, b: 10 } },
    }).png().toBuffer();
    const truncated = valid.subarray(0, valid.length - 8);
    await expect(normalizeUploadedImage(truncated, 'image/png'))
      .rejects.toMatchObject({ code: 'IMAGE_INVALID' });

    const tooWide = await sharp({
      create: { width: 8_001, height: 1, channels: 3, background: { r: 10, g: 10, b: 10 } },
    }).jpeg().toBuffer();
    await expect(normalizeUploadedImage(tooWide, 'image/jpeg'))
      .rejects.toMatchObject({ code: 'IMAGE_UNSUPPORTED' });

    const tooManyPixels = await sharp({
      create: { width: 4_001, height: 4_000, channels: 3, background: { r: 10, g: 10, b: 10 } },
    }).png().toBuffer();
    await expect(normalizeUploadedImage(tooManyPixels, 'image/png'))
      .rejects.toMatchObject({ code: 'IMAGE_UNSUPPORTED' });
  });
});
