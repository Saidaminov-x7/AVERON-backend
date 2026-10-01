import { beforeAll, describe, expect, it } from "vitest";

const secret = "JBSWY3DPEHPK3PXP";
let totpCrypto: typeof import("../admin-totp-crypto");
let consumeRecoveryCode: typeof import("../admin-totp").consumeRecoveryCode;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/test";
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.JWT_SECRET = "unit-test-jwt-secret-do-not-use-outside-tests-123";
  process.env.REFRESH_SECRET =
    "unit-test-refresh-secret-do-not-use-outside-tests-456";
  process.env.TOTP_ENCRYPTION_KEY = "a".repeat(64);
  totpCrypto = await import("../admin-totp-crypto");
  ({ consumeRecoveryCode } = await import("../admin-totp"));
});

describe("admin TOTP and recovery code helpers", () => {
  it("accepts the current TOTP and rejects invalid codes", () => {
    const timestamp = 1_800_000_000_000;
    const code = totpCrypto.createTotp(secret, "admin@example.test").generate({
      timestamp,
    });
    const invalidCode = `${(Number(code[0]) + 1) % 10}${code.slice(1)}`;

    expect(totpCrypto.verifyTotp(secret, code, timestamp)).not.toBeNull();
    expect(totpCrypto.verifyTotp(secret, "12345", timestamp)).toBeNull();
    expect(totpCrypto.verifyTotp(secret, invalidCode, timestamp)).toBeNull();
  });

  it("allows only the adjacent standard TOTP time window", () => {
    const timestamp = 1_800_000_000_000;
    const adjacentCode = totpCrypto.createTotp(secret, "admin").generate({
      timestamp: timestamp + 30_000,
    });

    expect(
      totpCrypto.verifyTotp(secret, adjacentCode, timestamp),
    ).not.toBeNull();
    expect(
      totpCrypto.verifyTotp(secret, adjacentCode, timestamp - 60_000),
    ).toBeNull();
  });

  it("generates unique recovery codes and matches stored hashes safely", () => {
    const codes = totpCrypto.generateRecoveryCodes();
    const hashes = codes.map(totpCrypto.hashRecoveryCode);

    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(
      totpCrypto.securelyMatchesRecoveryCode(codes[0].toLowerCase(), hashes),
    ).toBe(hashes[0]);
    expect(
      totpCrypto.securelyMatchesRecoveryCode("not-a-valid-code", hashes),
    ).toBeNull();
  });

  it("consumes a recovery code once and rejects replay", async () => {
    const code = "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-1111-2222";
    let used = false;
    const store = {
      findMany: async () => used ? [] : [{ codeHash: totpCrypto.hashRecoveryCode(code) }],
      updateMany: async () => {
        if (used) return { count: 0 };
        used = true;
        return { count: 1 };
      },
    };

    expect(await consumeRecoveryCode(store, "user-id", code)).toBe(true);
    expect(await consumeRecoveryCode(store, "user-id", code)).toBe(false);
  });

  it("encrypts TOTP secrets and rejects ciphertext tampering", () => {
    const encrypted = totpCrypto.encryptTotpSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(totpCrypto.decryptTotpSecret(encrypted)).toBe(secret);
    const [version, iv, tag, ciphertext] = encrypted.split(".");
    const tamperedTag = `${tag[0] === "A" ? "B" : "A"}${tag.slice(1)}`;
    const tampered = `${version}.${iv}.${tamperedTag}.${ciphertext}`;
    expect(() => totpCrypto.decryptTotpSecret(tampered)).toThrow();
  });

  it("keeps the server running without a key but refuses TOTP encryption", async () => {
    const { config } = await import("../../../config");
    const configuredKey = config.TOTP_ENCRYPTION_KEY;
    config.TOTP_ENCRYPTION_KEY = undefined;
    try {
      expect(() => totpCrypto.encryptTotpSecret(secret)).toThrow(
        "TOTP_ENCRYPTION_KEY must be configured",
      );
    } finally {
      config.TOTP_ENCRYPTION_KEY = configuredKey;
    }
  });
});
