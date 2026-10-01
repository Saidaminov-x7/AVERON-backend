import type { FastifyRequest } from 'fastify';

export interface UploadedMultipartFile {
  filename: string;
  mimetype: string;
  data: Buffer;
}

function multipartError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}

export async function readSingleMultipartFile(
  request: FastifyRequest,
  fieldName: string,
  maxFileSizeBytes: number,
): Promise<UploadedMultipartFile> {
  let uploaded: UploadedMultipartFile | undefined;
  try {
    for await (const part of request.parts({
      limits: { fileSize: maxFileSizeBytes, files: 1, fields: 0, parts: 1 },
    })) {
      if (part.type !== 'file' || part.fieldname !== fieldName || uploaded) {
        throw multipartError('Invalid multipart upload', 400);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      if (part.file.truncated) {
        throw multipartError('Uploaded file exceeds the configured limit', 413);
      }
      uploaded = {
        filename: part.filename,
        mimetype: part.mimetype,
        data: Buffer.concat(chunks),
      };
    }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : '';
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      throw multipartError('Uploaded file exceeds the configured limit', 413);
    }
    if (['FST_FILES_LIMIT', 'FST_FIELDS_LIMIT', 'FST_PARTS_LIMIT'].includes(code)) {
      throw multipartError('Invalid multipart upload', 400);
    }
    if (typeof error === 'object' && error !== null && 'statusCode' in error) throw error;
    throw error;
  }
  if (!uploaded) throw multipartError('No file provided', 400);
  return uploaded;
}
