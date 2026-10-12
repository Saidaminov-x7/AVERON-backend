import { createHash } from 'node:crypto';
import { validateBytes, type ValidationResult } from 'gltf-validator';

export const MAX_GLB_SIZE_BYTES = 50 * 1024 * 1024;
const MAX_JSON_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_MESHES = 2_000;
const MAX_ACCESSOR_ELEMENTS = 1_000_000;
const MAX_TEXTURE_DIMENSION = 8192;
const MAX_TOTAL_TEXTURE_PIXELS = 64_000_000;
const JSON_CHUNK_TYPE = 0x4e4f534a;
const BIN_CHUNK_TYPE = 0x004e4942;
const UNSUPPORTED_REQUIRED_EXTENSIONS = new Set([
  'KHR_draco_mesh_compression',
  'EXT_meshopt_compression',
  'KHR_texture_basisu',
]);

export type GlbValidationReport = {
  fileHash: string;
  fileSize: number;
  meshCount: number;
  vertexCount: number;
  materialCount: number;
  textureCount: number;
  warningCount: number;
  warnings: Array<{ code: string; message: string }>;
};

export class GlbValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'GlbValidationError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: string): never {
  throw new GlbValidationError(code);
}

/** Validates the GLB container and resource bounds without resolving any URI or executing model content. */
export function validateGlb(buffer: Buffer): GlbValidationReport {
  if (buffer.length < 20 || buffer.length > MAX_GLB_SIZE_BYTES) fail('GLB_SIZE_INVALID');
  if (buffer.toString('ascii', 0, 4) !== 'glTF') fail('GLB_MAGIC_INVALID');
  if (buffer.readUInt32LE(4) !== 2) fail('GLB_VERSION_UNSUPPORTED');
  if (buffer.readUInt32LE(8) !== buffer.length) fail('GLB_LENGTH_INVALID');

  let offset = 12;
  let jsonChunk: Buffer | undefined;
  let binaryChunk: Buffer | undefined;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) fail('GLB_CHUNK_INVALID');
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkLength % 4 !== 0 || chunkEnd > buffer.length) fail('GLB_CHUNK_INVALID');
    if (chunkType === JSON_CHUNK_TYPE) {
      if (jsonChunk || offset !== 12 || chunkLength > MAX_JSON_CHUNK_BYTES) fail('GLB_JSON_CHUNK_INVALID');
      jsonChunk = buffer.subarray(chunkStart, chunkEnd);
    } else if (chunkType === BIN_CHUNK_TYPE) {
      if (!jsonChunk || binaryChunk) fail('GLB_BINARY_CHUNK_INVALID');
      binaryChunk = buffer.subarray(chunkStart, chunkEnd);
    } else {
      fail('GLB_CHUNK_UNSUPPORTED');
    }
    offset = chunkEnd;
  }
  if (offset !== buffer.length || !jsonChunk) fail('GLB_JSON_CHUNK_MISSING');

  let document: Record<string, unknown>;
  try {
    document = JSON.parse(jsonChunk.toString('utf8').replace(/[\u0000\u0020]+$/u, '')) as Record<string, unknown>;
  } catch {
    fail('GLB_JSON_INVALID');
  }
  const asset = record(document.asset) ? document.asset : null;
  if (!asset || asset.version !== '2.0') fail('GLB_ASSET_VERSION_INVALID');
  const requiredExtensions = Array.isArray(document.extensionsRequired) ? document.extensionsRequired : [];
  if (requiredExtensions.some((extension) => typeof extension !== 'string' || UNSUPPORTED_REQUIRED_EXTENSIONS.has(extension))) {
    fail('GLB_REQUIRED_EXTENSION_UNSUPPORTED');
  }

  const buffers = Array.isArray(document.buffers) ? document.buffers : [];
  if (buffers.length > 1) fail('GLB_MULTIPLE_BUFFERS_UNSUPPORTED');
  if (buffers.some((item) => !record(item) || (typeof item.uri === 'string' && !item.uri.startsWith('data:')))) {
    fail('GLB_EXTERNAL_RESOURCE_FORBIDDEN');
  }
  if (buffers.some((item) => !record(item) || typeof item.byteLength !== 'number' || item.byteLength < 0 || item.byteLength > (binaryChunk?.length ?? 0))) {
    fail('GLB_BUFFER_INVALID');
  }

  const bufferViews = Array.isArray(document.bufferViews) ? document.bufferViews : [];
  for (const view of bufferViews) {
    if (!record(view) || view.buffer !== 0 || !Number.isSafeInteger(view.byteOffset ?? 0) || !Number.isSafeInteger(view.byteLength)) {
      fail('GLB_BUFFER_VIEW_INVALID');
    }
    const start = Number(view.byteOffset ?? 0);
    const length = Number(view.byteLength);
    if (start < 0 || length < 0 || start + length > (binaryChunk?.length ?? 0)) fail('GLB_BUFFER_VIEW_INVALID');
  }

  const images = Array.isArray(document.images) ? document.images : [];
  if (images.some((item) => !record(item) || 'uri' in item || !Number.isSafeInteger(item.bufferView))) {
    fail('GLB_EXTERNAL_RESOURCE_FORBIDDEN');
  }
  if (images.length > 32) fail('GLB_TEXTURE_COUNT_EXCEEDED');
  let totalTexturePixels = 0;
  for (const image of images) {
    const viewIndex = Number((image as Record<string, unknown>).bufferView);
    const view = bufferViews[viewIndex];
    if (!record(view)) fail('GLB_IMAGE_BUFFER_VIEW_INVALID');
    const imageBytes = binaryChunk?.subarray(Number(view.byteOffset ?? 0), Number(view.byteOffset ?? 0) + Number(view.byteLength));
    if (!imageBytes?.length) fail('GLB_IMAGE_INVALID');
    const mimeType = (image as Record<string, unknown>).mimeType;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(String(mimeType))) fail('GLB_IMAGE_MIME_INVALID');
    const dimensions = readImageDimensions(imageBytes, String(mimeType));
    if (!dimensions) fail('GLB_IMAGE_INVALID');
    if (dimensions.width > MAX_TEXTURE_DIMENSION || dimensions.height > MAX_TEXTURE_DIMENSION) fail('GLB_TEXTURE_DIMENSIONS_EXCEEDED');
    totalTexturePixels += dimensions.width * dimensions.height;
    if (totalTexturePixels > MAX_TOTAL_TEXTURE_PIXELS) fail('GLB_TEXTURE_MEMORY_EXCEEDED');
  }

  const meshes = Array.isArray(document.meshes) ? document.meshes : [];
  const accessors = Array.isArray(document.accessors) ? document.accessors : [];
  if (meshes.length > MAX_MESHES) fail('GLB_MESH_COUNT_EXCEEDED');
  const vertexCount = accessors.reduce((total, item) => {
    if (!record(item) || !Number.isSafeInteger(item.count) || Number(item.count) < 0) fail('GLB_ACCESSOR_INVALID');
    return total + Number(item.count);
  }, 0);
  if (vertexCount > MAX_ACCESSOR_ELEMENTS) fail('GLB_GEOMETRY_COMPLEXITY_EXCEEDED');
  if (!meshes.length || !Array.isArray(document.nodes) || !Array.isArray(document.scenes)) fail('GLB_SCENE_MISSING');

  return {
    fileHash: createHash('sha256').update(buffer).digest('hex'),
    fileSize: buffer.length,
    meshCount: meshes.length,
    vertexCount,
    materialCount: Array.isArray(document.materials) ? document.materials.length : 0,
    textureCount: images.length,
    warningCount: 0,
    warnings: [],
  };
}

export async function validateGlbWithKhronos(buffer: Buffer): Promise<GlbValidationReport> {
  const report = validateGlb(buffer);
  let result: ValidationResult;
  try {
    result = await validateBytes(new Uint8Array(buffer), { format: 'glb', maxIssues: 50 });
  } catch {
    fail('GLB_VALIDATOR_FAILED');
  }
  if (result.issues.numErrors > 0) {
    const firstError = result.issues.messages.find((issue) => issue.severity === 0);
    fail(firstError ? `GLB_KHRONOS_VALIDATION_FAILED:${firstError.code}` : 'GLB_KHRONOS_VALIDATION_FAILED');
  }
  return {
    ...report,
    warningCount: result.issues.numWarnings,
    warnings: result.issues.messages.filter((issue) => issue.severity === 1).slice(0, 20).map(({ code, message }) => ({ code, message })),
  };
}

function readImageDimensions(data: Buffer, mimeType: string): { width: number; height: number } | null {
  if (mimeType === 'image/png' && data.length >= 24 && data.toString('hex', 0, 8) === '89504e470d0a1a0a') {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (mimeType === 'image/jpeg' && data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    for (let offset = 2; offset + 9 < data.length;) {
      if (data[offset] !== 0xff) return null;
      const marker = data[offset + 1];
      const length = data.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > data.length) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  if (mimeType === 'image/webp' && data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const kind = data.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    }
    if (kind === 'VP8L' && data[20] === 0x2f) {
      return { width: 1 + (((data[22] & 0x3f) << 8) | data[21]), height: 1 + (((data[23] & 0x0f) << 10) | (data[22] >> 6) | (data[24] << 2)) };
    }
  }
  return null;
}
