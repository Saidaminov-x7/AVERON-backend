// apps/api/src/modules/auth/me.ts

import { FastifyReply, FastifyRequest } from 'fastify';
import { ProductCountry } from '@prisma/client';
import { z } from 'zod';

export const catalogCountryPreferenceSchema = z.object({
  country: z.nativeEnum(ProductCountry).nullable(),
}).strict();

export const bodyProfileSchema = z.object({
  heightCm: z.number().int().min(80).max(250).nullable(),
  weightKg: z.number().int().min(20).max(300).nullable(),
}).strict();

export const meHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const user = await request.server.prisma.user.findUnique({
    where: { id: request.user.userId },
    select: {
      id: true,
      email: true,
      phone: true,
      telegramId: true,
      name: true,
      avatar: true,
      defaultCatalogCountry: true,
      heightCm: true,
      weightKg: true,
      role: true,
      adminRole: true,
      lastLoginAt: true,
      verified: true,
      createdAt: true,
    },
  });

  if (!user) {
    return reply.status(404).send({ message: 'User not found' });
  }

  return reply.send({
    ...user,
    adminRole: user.adminRole ?? (user.role === 'ADMIN' ? 'SUPER_ADMIN' : null),
  });
};

export const updateBodyProfileHandler = async (request: FastifyRequest, reply: FastifyReply) => {
  const parsed = bodyProfileSchema.safeParse(request.body);
  if (!parsed.success) return reply.status(400).send({ message: 'Invalid body profile' });
  const user = await request.server.prisma.user.update({
    where: { id: request.user.userId },
    data: parsed.data,
    select: { heightCm: true, weightKg: true },
  });
  return reply.send(user);
};

export const updateCatalogCountryPreferenceHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const parsed = catalogCountryPreferenceSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      code: 'INVALID_CATALOG_COUNTRY',
      message: 'Invalid catalog country preference',
    });
  }

  const user = await request.server.prisma.user.update({
    where: { id: request.user.userId },
    data: { defaultCatalogCountry: parsed.data.country },
    select: { defaultCatalogCountry: true },
  });
  return reply.send(user);
};
