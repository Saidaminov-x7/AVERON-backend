import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import * as OTPAuth from "otpauth";
import { config } from "../../config";

const getEncryptionKey = () => {
  if (!config.TOTP_ENCRYPTION_KEY || !/^[\da-fA-F]{64}$/.test(config.TOTP_ENCRYPTION_KEY)) {
    throw new Error("TOTP_ENCRYPTION_KEY must be configured as 64 hexadecimal characters");
  }
  return Buffer.from(config.TOTP_ENCRYPTION_KEY, "hex");
};

export function encryptTotpSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptTotpSecret(encrypted: string): string {
  const [version, ivText, tagText, ciphertextText] = encrypted.split(".");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText) {
    throw new Error("Stored TOTP secret has an unsupported format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function createTotp(secret: string, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: "AVERON",
    label,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}

export function verifyTotp(
  secret: string,
  code: string,
  now = Date.now(),
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const totp = createTotp(secret, "admin");
  const delta = totp.validate({ token: code, timestamp: now, window: 1 });
  return delta === null ? null : Math.floor(now / 30_000) + delta;
}

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const value = randomBytes(16).toString("hex").toUpperCase();
    return value.match(/.{1,4}/g)!.join("-");
  });
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256")
    .update(code.replaceAll("-", "").toUpperCase())
    .digest("hex");
}

export function securelyMatchesRecoveryCode(
  code: string,
  hashes: string[],
): string | null {
  const inputHash = Buffer.from(hashRecoveryCode(code), "hex");
  for (const storedHash of hashes) {
    const candidate = Buffer.from(storedHash, "hex");
    if (
      candidate.length === inputHash.length &&
      timingSafeEqual(candidate, inputHash)
    )
      return storedHash;
  }
  return null;
}
