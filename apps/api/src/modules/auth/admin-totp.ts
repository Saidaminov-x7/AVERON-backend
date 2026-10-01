import argon2 from "argon2";
import QRCode from "qrcode";
import { randomBytes } from "node:crypto";
import * as OTPAuth from "otpauth";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { AdminRole, Role } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { adminMiddleware } from "../../lib/adminMiddleware";
import { generateTokens } from "../../lib/jwt";
import { refreshCookieOptions } from "../../lib/cookies";
import { saveAuthSession } from "./sessions";
import {
  createTotp,
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  securelyMatchesRecoveryCode,
  verifyTotp,
} from "./admin-totp-crypto";
import {
  adminTotpCodeSchema,
  adminTotpLoginSchema,
  adminTotpSensitiveActionSchema,
} from "./schemas";

const SETUP_TTL_SECONDS = 600;
const LOGIN_CHALLENGE_TTL_SECONDS = 300;
const MAX_CHALLENGE_ATTEMPTS = 5;

type AdminTotpUser = {
  id: string;
  email: string;
  name: string;
  avatar: string | null;
  passwordHash: string;
  role: Role;
  adminRole: AdminRole | null;
  isBlocked: boolean;
  adminTotpEnabled: boolean;
  adminTotpSecret: string | null;
  adminTotpLastCounter: bigint | null;
  isDeleted: boolean;
};

export interface RecoveryCodeStore {
  findMany(args: {
    where: { userId: string; usedAt: null };
    select: { codeHash: true };
  }): Promise<Array<{ codeHash: string }>>;
  updateMany(args: {
    where: { userId: string; codeHash: string; usedAt: null };
    data: { usedAt: Date };
  }): Promise<{ count: number }>;
}

async function getAdminTotpUser(
  request: FastifyRequest,
): Promise<AdminTotpUser | null> {
  const user = await request.server.prisma.user.findUnique({
    where: { id: request.user.userId },
    select: {
      id: true,
      email: true,
      name: true,
      avatar: true,
      passwordHash: true,
      role: true,
      adminRole: true,
      isBlocked: true,
      adminTotpEnabled: true,
      adminTotpSecret: true,
      adminTotpLastCounter: true,
      isDeleted: true,
    },
  });
  if (
    !user ||
    user.isBlocked ||
    user.isDeleted ||
    (user.role !== Role.ADMIN && !user.adminRole)
  )
    return null;
  return user;
}

async function verifyFreshTotp(
  request: FastifyRequest,
  user: AdminTotpUser,
  code: string,
): Promise<boolean> {
  if (!user.adminTotpSecret || !user.adminTotpEnabled) return false;
  const counter = verifyTotp(decryptTotpSecret(user.adminTotpSecret), code);
  if (
    counter === null ||
    (user.adminTotpLastCounter !== null &&
      BigInt(counter) <= user.adminTotpLastCounter)
  ) {
    return false;
  }
  const updated = await request.server.prisma.user.updateMany({
    where: {
      id: user.id,
      adminTotpEnabled: true,
      OR: [
        { adminTotpLastCounter: null },
        { adminTotpLastCounter: { lt: BigInt(counter) } },
      ],
    },
    data: { adminTotpLastCounter: BigInt(counter) },
  });
  return updated.count === 1;
}

export async function consumeRecoveryCode(
  store: RecoveryCodeStore,
  userId: string,
  code: string,
): Promise<boolean> {
  const storedCodes = await store.findMany({
    where: { userId, usedAt: null },
    select: { codeHash: true },
  });
  const match = securelyMatchesRecoveryCode(
    code,
    storedCodes.map(({ codeHash }) => codeHash),
  );
  if (!match) return false;
  const consumed = await store.updateMany({
    where: { userId, codeHash: match, usedAt: null },
    data: { usedAt: new Date() },
  });
  return consumed.count === 1;
}

async function storeRecoveryCodes(
  tx: Prisma.TransactionClient,
  userId: string,
  codes: string[],
) {
  await tx.adminRecoveryCode.deleteMany({ where: { userId } });
  await tx.adminRecoveryCode.createMany({
    data: codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })),
  });
}

async function issueAdminSession(
  request: FastifyRequest,
  user: AdminTotpUser,
  reply: FastifyReply,
) {
  const { accessToken, refreshToken, sessionId } = generateTokens(
    user,
    request,
  );
  const refreshTokenHash = await argon2.hash(refreshToken);
  await request.server.prisma.user.update({
    where: { id: user.id },
    data: { refreshTokenHash, lastLoginAt: new Date() },
  });
  await saveAuthSession(request, user.id, sessionId, refreshToken);
  reply.setCookie("refreshToken", refreshToken, refreshCookieOptions());
  return {
    accessToken,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      role: user.role,
      adminRole:
        user.adminRole ??
        (user.role === Role.ADMIN ? AdminRole.SUPER_ADMIN : null),
    },
  };
}

export const adminTotpModule: FastifyPluginAsync = async (server) => {
  server.get(
    "/admin/totp/status",
    { preHandler: adminMiddleware },
    async (request, reply) => {
      const user = await getAdminTotpUser(request);
      if (!user)
        return reply.status(403).send({ message: "Admin account required" });
      const unusedRecoveryCodes = await server.prisma.adminRecoveryCode.count({
        where: { userId: user.id, usedAt: null },
      });
      return reply.send({
        enabled: user.adminTotpEnabled,
        unusedRecoveryCodes,
      });
    },
  );

  server.post(
    "/admin/totp/setup",
    {
      preHandler: adminMiddleware,
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const user = await getAdminTotpUser(request);
      if (!user)
        return reply.status(403).send({ message: "Admin account required" });
      if (user.adminTotpEnabled)
        return reply
          .status(409)
          .send({ message: "Two-factor authentication is already enabled" });

      const generatedSecret = new OTPAuth.Secret().base32;
      let encryptedSecret: string;
      try {
        encryptedSecret = encryptTotpSecret(generatedSecret);
      } catch {
        return reply
          .status(503)
          .send({ message: "Admin two-factor setup is not available" });
      }
      const totp = createTotp(generatedSecret, user.email);
      const setupToken = randomBytes(32).toString("hex");
      await server.redis.set(
        `admin-totp-setup:${user.id}:${setupToken}`,
        encryptedSecret,
        "EX",
        SETUP_TTL_SECONDS,
      );
      const otpauthUri = totp.toString();
      const qrCodeDataUrl = await QRCode.toDataURL(otpauthUri, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 240,
      });
      return reply.send({
        setupToken,
        secret: generatedSecret,
        otpauthUri,
        qrCodeDataUrl,
        expiresInSeconds: SETUP_TTL_SECONDS,
      });
    },
  );

  server.post<{ Body: { setupToken: string; code: string } }>(
    "/admin/totp/enable",
    {
      preHandler: adminMiddleware,
      config: { rateLimit: { max: 8, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const user = await getAdminTotpUser(request);
      if (!user)
        return reply.status(403).send({ message: "Admin account required" });
      const body = adminTotpCodeSchema
        .extend({ setupToken: adminTotpLoginSchema.shape.challengeToken })
        .parse(request.body);
      if (user.adminTotpEnabled)
        return reply
          .status(409)
          .send({ message: "Two-factor authentication is already enabled" });
      const setupKey = `admin-totp-setup:${user.id}:${body.setupToken}`;
      const encryptedSecret = await server.redis.get(setupKey);
      if (!encryptedSecret)
        return reply
          .status(400)
          .send({ message: "Setup expired. Start again." });
      const secret = decryptTotpSecret(encryptedSecret);
      const counter = verifyTotp(secret, body.code);
      if (counter === null)
        return reply
          .status(400)
          .send({ message: "Invalid authenticator code" });

      const recoveryCodes = generateRecoveryCodes();
      await server.prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: {
            adminTotpSecret: encryptedSecret,
            adminTotpEnabled: true,
            adminTotpLastCounter: BigInt(counter),
          },
        });
        await storeRecoveryCodes(tx, user.id, recoveryCodes);
      });
      await server.redis.del(setupKey);
      return reply.send({ enabled: true, recoveryCodes });
    },
  );

  server.post<{ Body: { currentPassword: string; code: string } }>(
    "/admin/totp/recovery-codes",
    {
      preHandler: adminMiddleware,
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const user = await getAdminTotpUser(request);
      if (!user)
        return reply.status(403).send({ message: "Admin account required" });
      const body = adminTotpSensitiveActionSchema.parse(request.body);
      if (!(await argon2.verify(user.passwordHash, body.currentPassword))) {
        return reply.status(400).send({ message: "Verification failed" });
      }
      if (!(await verifyFreshTotp(request, user, body.code)))
        return reply.status(400).send({ message: "Verification failed" });

      const recoveryCodes = generateRecoveryCodes();
      await server.prisma.$transaction((tx) =>
        storeRecoveryCodes(tx, user.id, recoveryCodes),
      );
      return reply.send({ recoveryCodes });
    },
  );

  server.post<{ Body: { currentPassword: string; code: string } }>(
    "/admin/totp/disable",
    {
      preHandler: adminMiddleware,
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const user = await getAdminTotpUser(request);
      if (!user)
        return reply.status(403).send({ message: "Admin account required" });
      const body = adminTotpSensitiveActionSchema.parse(request.body);
      if (!(await argon2.verify(user.passwordHash, body.currentPassword))) {
        return reply.status(400).send({ message: "Verification failed" });
      }
      if (!(await verifyFreshTotp(request, user, body.code)))
        return reply.status(400).send({ message: "Verification failed" });
      await server.prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: {
            adminTotpEnabled: false,
            adminTotpSecret: null,
            adminTotpLastCounter: null,
          },
        });
        await tx.adminRecoveryCode.deleteMany({ where: { userId: user.id } });
      });
      return reply.send({ enabled: false });
    },
  );

  server.post<{ Body: { challengeToken: string; code: string } }>(
    "/login/verify-totp",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "15 minutes",
          keyGenerator: (request) =>
            `${request.ip}:${(request.body as { challengeToken?: string })?.challengeToken ?? "unknown"}`,
        },
      },
    },
    async (request, reply) => {
      const body = adminTotpLoginSchema.parse(request.body);
      const key = `admin-totp-login:${body.challengeToken}`;
      const lock = `${key}:verify-lock`;
      const acquired = await server.redis.set(lock, "1", "EX", 15, "NX");
      if (!acquired)
        return reply.status(429).send({ message: "Please wait and try again" });
      try {
        const challengeJson = await server.redis.get(key);
        if (!challengeJson)
          return reply
            .status(401)
            .send({ message: "Invalid or expired sign-in challenge" });
        const challenge = JSON.parse(challengeJson) as {
          userId: string;
          attempts: number;
        };
        const user = await server.prisma.user.findUnique({
          where: { id: challenge.userId },
          select: {
            id: true,
            email: true,
            name: true,
            avatar: true,
            role: true,
            adminRole: true,
            passwordHash: true,
            isBlocked: true,
            adminTotpEnabled: true,
            adminTotpSecret: true,
            adminTotpLastCounter: true,
            twoFactorEnabled: true,
            twoFactorSecret: true,
            refreshTokenHash: true,
            verified: true,
            phone: true,
            lastLoginAt: true,
            createdAt: true,
            updatedAt: true,
            blockedAt: true,
            blockedReason: true,
            isDeleted: true,
            deletedAt: true,
          },
        });
        const validAdmin =
          user &&
          !user.isBlocked &&
          !user.isDeleted &&
          user.adminTotpEnabled &&
          (user.role === Role.ADMIN || !!user.adminRole);
        if (!validAdmin || !user.adminTotpSecret) {
          await server.redis.del(key);
          return reply
            .status(401)
            .send({ message: "Invalid or expired sign-in challenge" });
        }

        let verified = false;
        const counter = verifyTotp(
          decryptTotpSecret(user.adminTotpSecret),
          body.code,
        );
        if (counter !== null) {
          const consumed = await server.prisma.user.updateMany({
            where: {
              id: user.id,
              adminTotpEnabled: true,
              OR: [
                { adminTotpLastCounter: null },
                { adminTotpLastCounter: { lt: BigInt(counter) } },
              ],
            },
            data: { adminTotpLastCounter: BigInt(counter) },
          });
          verified = consumed.count === 1;
        } else {
          verified = await consumeRecoveryCode(
            server.prisma.adminRecoveryCode,
            user.id,
            body.code,
          );
        }

        if (!verified) {
          const attempts = challenge.attempts + 1;
          if (attempts >= MAX_CHALLENGE_ATTEMPTS) {
            await server.redis.del(key);
          } else {
            const ttl = await server.redis.ttl(key);
            await server.redis.set(
              key,
              JSON.stringify({ ...challenge, attempts }),
              "EX",
              Math.max(ttl, 1),
            );
          }
          return reply
            .status(401)
            .send({ message: "Invalid or expired sign-in challenge" });
        }

        await server.redis.del(key);
        const session = await issueAdminSession(request, user, reply);
        return reply.send(session);
      } finally {
        await server.redis.del(lock);
      }
    },
  );
};
