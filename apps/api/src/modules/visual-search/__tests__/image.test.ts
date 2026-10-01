import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { VisualSearchError } from '../errors';
import { normalizeUploadedImage } from '../image';

describe('visual-search image validation', () => {
  it('accepts, rotates, resizes and re-encodes a supported JPEG', async () => {
    const input = await sharp({
      create: { width: 1600, height: 900, channels: 3, background: { r: 20, g: 30, b: 40 } },
    }).jpeg().toBuffer();

    const normalized = await normalizeUploadedImage(input, 'image/jpeg');
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
});
