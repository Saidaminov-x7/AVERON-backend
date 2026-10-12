import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";

export const TEMPORARY_SOURCE_RESTRICTION_SECONDS = 10 * 60;
const RESTRICTION_PREFIX = "averon:v1:security:temporary-source-restriction";

export interface TemporarySourceRestrictionStore {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    expiryMode: "EX",
    seconds: number,
    condition: "NX",
  ): Promise<"OK" | null>;
}

function restrictionKey(sourceIp: string): string {
  const sourceHash = createHash("sha256").update(sourceIp).digest("hex");
  return `${RESTRICTION_PREFIX}:${sourceHash}`;
}

/**
 * Add a short-lived, IP-only restriction after a confirmed anonymous route scan.
 * The raw source address is never stored in the Redis key or value.
 */
export async function restrictSourceTemporarily(
  redis: TemporarySourceRestrictionStore,
  sourceIp: string,
  reason: "unmatched-route-scan" | "resource-id-probe",
): Promise<boolean> {
  if (!sourceIp.trim()) return false;
  const result = await redis.set(
    restrictionKey(sourceIp),
    reason,
    "EX",
    TEMPORARY_SOURCE_RESTRICTION_SECONDS,
    "NX",
  );
  return result === "OK";
}

/** Fail open if Redis is unavailable; the ordinary route-specific rate limits remain active. */
export async function isSourceTemporarilyRestricted(
  redis: Pick<TemporarySourceRestrictionStore, "get">,
  sourceIp: string,
): Promise<boolean> {
  if (!sourceIp.trim()) return false;
  try {
    return (await redis.get(restrictionKey(sourceIp))) !== null;
  } catch {
    return false;
  }
}

export function registerTemporarySourceRestrictionGuard(
  server: FastifyInstance,
  redis: Pick<TemporarySourceRestrictionStore, "get">,
): void {
  server.addHook("onRequest", async (request, reply) => {
    if (!(await isSourceTemporarilyRestricted(redis, request.ip))) return;
    return reply.status(429).send({
      statusCode: 429,
      error: "Too Many Requests",
      message: "Too many suspicious requests. Try again later.",
    });
  });
}
