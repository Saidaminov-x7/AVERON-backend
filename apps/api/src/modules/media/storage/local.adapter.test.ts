import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalStorageAdapter } from './local.adapter';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe('local media storage reads', () => {
  it('reads only stored upload URLs and rejects path traversal', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'averon-media-'));
    temporaryDirectories.push(storagePath);
    const month = '2026-10';
    const filename = `${randomUUID()}.webp`;
    const data = Buffer.from('stored image bytes');
    await mkdir(join(storagePath, month));
    await writeFile(join(storagePath, month, filename), data);

    const adapter = new LocalStorageAdapter(storagePath);
    await expect(adapter.read(`/uploads/${month}/${filename}`)).resolves.toEqual(data);
    await expect(adapter.read('/uploads/../outside.webp')).rejects.toThrow('MEDIA_STORAGE_URL_INVALID');
  });
});
