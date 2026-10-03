import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { adminMiddleware } from '../../lib/adminMiddleware';
import { authMiddleware } from '../../lib/authMiddleware';

const codeSchema = z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/);
const createSchema = z.object({
  code: codeSchema,
  discountPercent: z.number().int().min(1).max(15),
  maxActivations: z.number().int().positive().nullable().optional(),
  isActive: z.boolean().default(true),
  startsAt: z.string().datetime().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
}).strict().refine((value) => !value.startsAt || !value.expiresAt || value.startsAt < value.expiresAt);
const updateSchema = z.object({
  code: codeSchema.optional(),
  discountPercent: z.number().int().min(1).max(15).optional(),
  maxActivations: z.number().int().positive().nullable().optional(),
  isActive: z.boolean().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0);
const validateSchema = z.object({ code: codeSchema }).strict();

export function normalizePromoCode(code: string): string {
  return code.trim().toUpperCase();
}

export function promoFailureCode(promo: {
  isActive: boolean;
  startsAt: Date | null;
  expiresAt: Date | null;
  maxActivations: number | null;
  usedActivations: number;
}, now = new Date()): string | null {
  if (!promo.isActive) return 'PROMO_NOT_ACTIVE';
  if (promo.startsAt && promo.startsAt > now) return 'PROMO_NOT_STARTED';
  if (promo.expiresAt && promo.expiresAt <= now) return 'PROMO_EXPIRED';
  if (promo.maxActivations !== null && promo.usedActivations >= promo.maxActivations) return 'PROMO_LIMIT_REACHED';
  return null;
}

function remainingActivations(max: number | null, used: number): number | null {
  return max === null ? null : Math.max(0, max - used);
}

export const commercePromosModule: FastifyPluginAsync = async (app) => {
  app.post('/promo-codes/validate', {
    preHandler: authMiddleware,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const parsed = validateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ code: 'PROMO_INVALID', message: 'Promo code is invalid' });
    const promo = await app.prisma.commercePromoCode.findUnique({
      where: { normalizedCode: normalizePromoCode(parsed.data.code) },
    });
    if (!promo) return reply.status(404).send({ code: 'PROMO_NOT_FOUND', message: 'Promo code was not found' });
    const failure = promoFailureCode(promo);
    if (failure) return reply.status(409).send({ code: failure, message: failure });
    const used = await app.prisma.commercePromoCodeUsage.findUnique({
      where: { promoCodeId_userId: { promoCodeId: promo.id, userId: request.user.userId } },
      select: { id: true },
    });
    if (used) return reply.status(409).send({ code: 'PROMO_ALREADY_USED', message: 'Promo code was already used' });
    return {
      valid: true,
      code: promo.code,
      discountPercent: promo.discountPercent,
      consumed: false,
    };
  });

  app.get('/admin/commerce/promo-codes', { preHandler: adminMiddleware }, async () => {
    const promos = await app.prisma.commercePromoCode.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return promos.map((promo) => ({
      ...promo,
      remainingActivations: remainingActivations(promo.maxActivations, promo.usedActivations),
      status: promoFailureCode(promo) ?? 'ACTIVE',
    }));
  });

  app.post('/admin/commerce/promo-codes', { preHandler: adminMiddleware }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ code: 'PROMO_INVALID', message: 'Promo code configuration is invalid' });
    if (parsed.data.startsAt && parsed.data.expiresAt &&
        new Date(parsed.data.startsAt) >= new Date(parsed.data.expiresAt)) {
      return reply.status(400).send({ code: 'PROMO_INVALID', message: 'Start time must precede expiry time' });
    }
    try {
      const promo = await app.prisma.commercePromoCode.create({
        data: {
          code: normalizePromoCode(parsed.data.code),
          normalizedCode: normalizePromoCode(parsed.data.code),
          discountPercent: parsed.data.discountPercent,
          maxActivations: parsed.data.maxActivations ?? null,
          isActive: parsed.data.isActive,
          startsAt: parsed.data.startsAt ? new Date(parsed.data.startsAt) : null,
          expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
        },
      });
      return reply.status(201).send({
        ...promo,
        remainingActivations: remainingActivations(promo.maxActivations, promo.usedActivations),
        status: promoFailureCode(promo) ?? 'ACTIVE',
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error &&
          (error as { code: string }).code === 'P2002') {
        return reply.status(409).send({ code: 'PROMO_INVALID', message: 'Promo code already exists' });
      }
      throw error;
    }
  });

  app.patch<{ Params: { promoId: string } }>('/admin/commerce/promo-codes/:promoId', {
    preHandler: adminMiddleware,
  }, async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ code: 'PROMO_INVALID', message: 'Promo code configuration is invalid' });
    const existing = await app.prisma.commercePromoCode.findUnique({ where: { id: request.params.promoId } });
    if (!existing) return reply.status(404).send({ code: 'PROMO_NOT_FOUND', message: 'Promo code was not found' });
    if (parsed.data.maxActivations !== undefined && parsed.data.maxActivations !== null &&
        parsed.data.maxActivations < existing.usedActivations) {
      return reply.status(409).send({ code: 'PROMO_LIMIT_BELOW_USAGE', message: 'Activation limit cannot be lower than usage already consumed' });
    }
    const startsAt = parsed.data.startsAt === undefined ? existing.startsAt :
      parsed.data.startsAt === null ? null : new Date(parsed.data.startsAt);
    const expiresAt = parsed.data.expiresAt === undefined ? existing.expiresAt :
      parsed.data.expiresAt === null ? null : new Date(parsed.data.expiresAt);
    if (startsAt && expiresAt && startsAt >= expiresAt) {
      return reply.status(400).send({ code: 'PROMO_INVALID', message: 'Start time must precede expiry time' });
    }
    try {
      const normalizedCode = parsed.data.code === undefined
        ? existing.normalizedCode
        : normalizePromoCode(parsed.data.code);
      const updated = await app.prisma.commercePromoCode.updateMany({
        where: {
          id: existing.id,
          ...(parsed.data.maxActivations !== undefined && parsed.data.maxActivations !== null
            ? { usedActivations: { lte: parsed.data.maxActivations } }
            : {}),
        },
        data: {
          ...(parsed.data.code !== undefined ? { code: normalizedCode, normalizedCode } : {}),
          ...(parsed.data.discountPercent !== undefined ? { discountPercent: parsed.data.discountPercent } : {}),
          ...(parsed.data.maxActivations !== undefined ? { maxActivations: parsed.data.maxActivations } : {}),
          ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
          ...(parsed.data.startsAt !== undefined ? { startsAt } : {}),
          ...(parsed.data.expiresAt !== undefined ? { expiresAt } : {}),
        },
      });
      if (updated.count !== 1) {
        return reply.status(409).send({ code: 'PROMO_LIMIT_BELOW_USAGE', message: 'Activation limit cannot be lower than usage already consumed' });
      }
      const promo = await app.prisma.commercePromoCode.findUnique({ where: { id: existing.id } });
      if (!promo) return reply.status(404).send({ code: 'PROMO_NOT_FOUND', message: 'Promo code was not found' });
      return {
        ...promo,
        remainingActivations: remainingActivations(promo.maxActivations, promo.usedActivations),
        status: promoFailureCode(promo) ?? 'ACTIVE',
      };
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error &&
          (error as { code: string }).code === 'P2002') {
        return reply.status(409).send({ code: 'PROMO_INVALID', message: 'Promo code already exists' });
      }
      throw error;
    }
  });

  app.delete<{ Params: { promoId: string } }>('/admin/commerce/promo-codes/:promoId', {
    preHandler: adminMiddleware,
  }, async (request, reply) => {
    const promo = await app.prisma.commercePromoCode.findUnique({
      where: { id: request.params.promoId },
      select: { id: true },
    });
    if (!promo) return reply.status(404).send({ code: 'PROMO_NOT_FOUND', message: 'Promo code was not found' });
    const usageCount = await app.prisma.commercePromoCodeUsage.count({
      where: { promoCodeId: promo.id },
    });
    if (usageCount > 0) {
      await app.prisma.commercePromoCode.update({
        where: { id: promo.id },
        data: { isActive: false },
      });
      return { deleted: false, archived: true };
    }
    await app.prisma.commercePromoCode.delete({ where: { id: promo.id } });
    return { deleted: true, archived: false };
  });

  app.get<{ Params: { promoId: string } }>('/admin/commerce/promo-codes/:promoId/usages', {
    preHandler: adminMiddleware,
  }, async (request, reply) => {
    const promo = await app.prisma.commercePromoCode.findUnique({
      where: { id: request.params.promoId },
      select: { id: true },
    });
    if (!promo) return reply.status(404).send({ code: 'PROMO_NOT_FOUND', message: 'Promo code was not found' });
    const usages = await app.prisma.commercePromoCodeUsage.findMany({
      where: { promoCodeId: promo.id },
      orderBy: { usedAt: 'desc' },
      take: 100,
      select: {
        user: { select: { name: true } },
        order: { select: { orderNumber: true } },
        discountPercentSnapshot: true,
        subtotal: true,
        discountAmount: true,
        finalTotal: true,
        usedAt: true,
      },
    });
    return usages.map((usage) => ({
      customer: usage.user.name,
      orderNumber: usage.order.orderNumber,
      discountPercent: usage.discountPercentSnapshot,
      subtotalUzs: usage.subtotal.toString(),
      discountUzs: usage.discountAmount.toString(),
      finalTotalUzs: usage.finalTotal.toString(),
      usedAt: usage.usedAt,
    }));
  });
};
