import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import {
  isSourceTemporarilyRestricted,
  registerTemporarySourceRestrictionGuard,
  restrictSourceTemporarily,
} from "./temporary-source-restriction";

describe("temporary source restriction", () => {
  it("stores only a hashed source key with a short TTL and does not overwrite an active restriction", async () => {
    const set = vi.fn(async (): Promise<"OK" | null> => "OK");
    const redis = { get: vi.fn(async () => null), set };

    await expect(
      restrictSourceTemporarily(redis, "203.0.113.25", "unmatched-route-scan"),
    ).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith(
      expect.stringMatching(
        /^averon:v1:security:temporary-source-restriction:[a-f0-9]{64}$/,
      ),
      "unmatched-route-scan",
      "EX",
      600,
      "NX",
    );
    expect(JSON.stringify(set.mock.calls)).not.toContain("203.0.113.25");

    set.mockResolvedValueOnce(null);
    await expect(
      restrictSourceTemporarily(redis, "203.0.113.25", "unmatched-route-scan"),
    ).resolves.toBe(false);
  });

  it("reports current restrictions and fails open when Redis is unavailable", async () => {
    const get = vi.fn(async () => "unmatched-route-scan" as string | null);
    await expect(
      isSourceTemporarilyRestricted({ get }, "203.0.113.25"),
    ).resolves.toBe(true);

    get.mockResolvedValueOnce(null);
    await expect(
      isSourceTemporarilyRestricted({ get }, "203.0.113.25"),
    ).resolves.toBe(false);

    get.mockRejectedValueOnce(new Error("Redis unavailable"));
    await expect(
      isSourceTemporarilyRestricted({ get }, "203.0.113.25"),
    ).resolves.toBe(false);
  });

  it("returns 429 only for an already restricted source and otherwise keeps URLs accessible", async () => {
    const app = Fastify();
    const get = vi.fn(async () => null as string | null);
    const handler = vi.fn(async () => ({ ok: true }));
    registerTemporarySourceRestrictionGuard(app, { get });
    app.get("/resource", handler);

    try {
      const normal = await app.inject({ method: "GET", url: "/resource" });
      expect(normal.statusCode).toBe(200);
      expect(handler).toHaveBeenCalledOnce();

      get.mockResolvedValueOnce("unmatched-route-scan");
      const restricted = await app.inject({ method: "GET", url: "/resource" });
      expect(restricted.statusCode).toBe(429);
      expect(restricted.json()).toEqual({
        statusCode: 429,
        error: "Too Many Requests",
        message: "Too many suspicious requests. Try again later.",
      });
      expect(handler).toHaveBeenCalledOnce();

      get.mockRejectedValueOnce(new Error("Redis unavailable"));
      const redisUnavailable = await app.inject({
        method: "GET",
        url: "/resource",
      });
      expect(redisUnavailable.statusCode).toBe(200);
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});
