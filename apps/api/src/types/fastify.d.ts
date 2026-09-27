// apps/api/src/types/fastify.d.ts

import { PrismaClient, AdminRole } from '@prisma/client';
import { Redis } from 'ioredis';
import 'fastify';
import '@fastify/jwt';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: {
      userId: string;
      role: string;
      adminRole?: AdminRole | null;
    };
    user: {
      userId: string;
      role: string;
      adminRole?: AdminRole | null;
    };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    redis: Redis;
  }
}
