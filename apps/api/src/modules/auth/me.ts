// apps/api/src/modules/auth/me.ts

import { FastifyReply, FastifyRequest } from 'fastify';

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
      name: true,
      avatar: true,
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