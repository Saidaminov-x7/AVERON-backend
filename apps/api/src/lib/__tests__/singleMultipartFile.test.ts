import Fastify from 'fastify';
import { fastifyMultipart } from '@fastify/multipart';
import { describe, expect, it } from 'vitest';
import { readSingleMultipartFile } from '../singleMultipartFile';

function multipart(parts: Array<{ name: string; filename?: string; data: string }>) {
  const boundary = 'single-file-boundary';
  const body = parts.map(({ name, filename, data }) => {
    const disposition = filename
      ? `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`
      : `Content-Disposition: form-data; name="${name}"\r\n\r\n`;
    return `--${boundary}\r\n${disposition}${data}\r\n`;
  }).join('') + `--${boundary}--\r\n`;
  return { boundary, body };
}

async function requestFile(parts: Array<{ name: string; filename?: string; data: string }>, maxBytes = 32) {
  const app = Fastify();
  await app.register(fastifyMultipart);
  app.post('/upload', async (request) => readSingleMultipartFile(request, 'file', maxBytes));
  const form = multipart(parts);
  const response = await app.inject({
    method: 'POST',
    url: '/upload',
    headers: { 'content-type': `multipart/form-data; boundary=${form.boundary}` },
    payload: form.body,
  });
  await app.close();
  return response;
}

describe('single multipart upload validation', () => {
  it('accepts one file in the expected field', async () => {
    const response = await requestFile([{ name: 'file', filename: 'image.jpg', data: 'image bytes' }]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      filename: 'image.jpg',
      mimetype: 'image/jpeg',
      data: Buffer.from('image bytes').toJSON(),
    });
  });

  it('rejects unexpected fields and additional files', async () => {
    const unexpectedField = await requestFile([{ name: 'caption', data: 'not expected' }]);
    const multipleFiles = await requestFile([
      { name: 'file', filename: 'first.jpg', data: 'first' },
      { name: 'file', filename: 'second.jpg', data: 'second' },
    ]);
    expect(unexpectedField.statusCode).toBe(400);
    expect(multipleFiles.statusCode).toBe(400);
  });

  it('rejects files that exceed the configured byte limit', async () => {
    const response = await requestFile([{ name: 'file', filename: 'large.jpg', data: 'x'.repeat(64) }], 8);
    expect(response.statusCode).toBe(413);
  });
});
