import { describe, expect, it } from 'vitest';
import { GlbValidationError, validateGlb, validateGlbWithKhronos } from './glb-validation';

function makeGlb(document: Record<string, unknown>, binary = Buffer.alloc(36)) {
  const json = Buffer.from(JSON.stringify(document));
  const paddedJson = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const chunkHeader = (size: number, kind: number) => {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(size, 0);
    header.writeUInt32LE(kind, 4);
    return header;
  };
  const chunks = [chunkHeader(paddedJson.length, 0x4e4f534a), paddedJson, chunkHeader(binary.length, 0x004e4942), binary];
  const length = 12 + chunks.reduce((total, chunk) => total + chunk.length, 0);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(length, 8);
  return Buffer.concat([header, ...chunks]);
}

const validDocument = {
  asset: { version: '2.0' },
  buffers: [{ byteLength: 36 }],
  bufferViews: [{ buffer: 0, byteLength: 36 }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [0, 0, 0] }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  nodes: [{ mesh: 0 }],
  scenes: [{ nodes: [0] }],
  scene: 0,
};

describe('validateGlb', () => {
  it('accepts an embedded GLB 2.0 model and reports bounded metadata', async () => {
    const buffer = makeGlb(validDocument);
    const report = await validateGlbWithKhronos(buffer);
    expect(report).toMatchObject({
      fileSize: buffer.length,
      meshCount: 1,
      vertexCount: 3,
      materialCount: 0,
      textureCount: 0,
      warningCount: expect.any(Number),
    });
    expect(report.fileHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects external image resources before storing the model', () => {
    const buffer = makeGlb({ ...validDocument, images: [{ uri: 'https://example.com/texture.png' }] });
    expect(() => validateGlb(buffer)).toThrowError(GlbValidationError);
    expect(() => validateGlb(buffer)).toThrowError('GLB_EXTERNAL_RESOURCE_FORBIDDEN');
  });

  it('rejects a malformed container', () => {
    const buffer = makeGlb(validDocument);
    buffer.write('nope', 0, 'ascii');
    expect(() => validateGlb(buffer)).toThrowError('GLB_MAGIC_INVALID');
  });
});
