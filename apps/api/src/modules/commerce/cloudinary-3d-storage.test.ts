import { beforeEach, describe, expect, it, vi } from "vitest";

const cloudinaryMock = vi.hoisted(() => ({
  config: vi.fn(),
  url: vi.fn(),
  uploader: {
    upload_stream: vi.fn(),
    destroy: vi.fn(),
  },
}));

vi.mock("cloudinary", () => ({ v2: cloudinaryMock }));
vi.mock("../../config", () => ({
  config: {
    CLOUDINARY_CLOUD_NAME: "averon-test",
    CLOUDINARY_API_KEY: "test-key",
    CLOUDINARY_API_SECRET: "test-secret",
  },
}));

import { Cloudinary3dStorage } from "./cloudinary-3d-storage";

describe("Cloudinary3dStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores GLB files as authenticated assets and returns only a signed HTTPS delivery URL", async () => {
    const fileKey = "averon/fitting-room/sha256-asset-id";
    const data = Buffer.from("glb-fixture");
    const end = vi.fn();
    cloudinaryMock.uploader.upload_stream.mockImplementation(
      (options, callback) => {
        expect(options).toMatchObject({
          resource_type: "image",
          type: "authenticated",
          format: "glb",
          folder: "averon/fitting-room",
          overwrite: false,
        });
        expect(options.public_id).toMatch(/^a{64}-[0-9a-f-]{36}$/);
        end.mockImplementation((uploadedData: Buffer) => {
          expect(uploadedData).toBe(data);
          callback(null, { public_id: fileKey });
        });
        return { end };
      },
    );
    cloudinaryMock.url.mockReturnValue(
      "https://res.cloudinary.com/averon-test/image/authenticated/s--signature--/averon/fitting-room/asset.glb",
    );

    const storage = new Cloudinary3dStorage();
    await expect(storage.upload(data, "a".repeat(64))).resolves.toBe(fileKey);
    expect(end).toHaveBeenCalledOnce();
    expect(cloudinaryMock.url).not.toHaveBeenCalled();

    expect(storage.signedUrl(fileKey)).toContain(
      "/image/authenticated/s--signature--/",
    );
    expect(cloudinaryMock.url).toHaveBeenCalledWith(fileKey, {
      resource_type: "image",
      type: "authenticated",
      secure: true,
      sign_url: true,
      format: "glb",
    });
  });

  it("deletes only authenticated GLB assets and reports provider failures", async () => {
    const storage = new Cloudinary3dStorage();
    cloudinaryMock.uploader.destroy.mockResolvedValue({ result: "ok" });

    await expect(
      storage.delete("averon/fitting-room/asset"),
    ).resolves.toBeUndefined();
    expect(cloudinaryMock.uploader.destroy).toHaveBeenCalledWith(
      "averon/fitting-room/asset",
      {
        resource_type: "image",
        type: "authenticated",
        invalidate: true,
      },
    );

    cloudinaryMock.uploader.destroy.mockResolvedValueOnce({ result: "denied" });
    await expect(storage.delete("averon/fitting-room/asset")).rejects.toThrow(
      "FITTING_ROOM_STORAGE_DELETE_FAILED",
    );
  });
});
