import { randomUUID } from 'node:crypto';
import { v2 as cloudinary } from 'cloudinary';
import { config } from '../../config';

export class Cloudinary3dStorage {
  constructor() {
    if (!config.CLOUDINARY_CLOUD_NAME || !config.CLOUDINARY_API_KEY || !config.CLOUDINARY_API_SECRET) {
      throw new Error('FITTING_ROOM_STORAGE_UNAVAILABLE');
    }
    cloudinary.config({
      cloud_name: config.CLOUDINARY_CLOUD_NAME,
      api_key: config.CLOUDINARY_API_KEY,
      api_secret: config.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }

  async upload(data: Buffer, hash: string): Promise<string> {
    const publicId = `averon/fitting-room/${hash}-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream({
        resource_type: 'image',
        type: 'authenticated',
        format: 'glb',
        folder: 'averon/fitting-room',
        public_id: publicId.split('/').at(-1),
        overwrite: false,
      }, (error, result) => {
        if (error || !result) return reject(new Error('FITTING_ROOM_STORAGE_UPLOAD_FAILED'));
        resolve(result.public_id);
      });
      stream.end(data);
    });
  }

  signedUrl(fileKey: string): string {
    return cloudinary.url(fileKey, {
      resource_type: 'image',
      type: 'authenticated',
      secure: true,
      sign_url: true,
      format: 'glb',
    });
  }

  async delete(fileKey: string): Promise<void> {
    const result = await cloudinary.uploader.destroy(fileKey, {
      resource_type: 'image',
      type: 'authenticated',
      invalidate: true,
    });
    if (!['ok', 'not found'].includes(result.result)) {
      throw new Error('FITTING_ROOM_STORAGE_DELETE_FAILED');
    }
  }
}
