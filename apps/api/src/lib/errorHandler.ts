// apps/api/src/lib/errorHandler.ts

import { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { ZodError } from 'zod';

export function registerErrorHandler(server: FastifyInstance) {
  server.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        message: 'Ошибка валидации',
        errors: error.flatten(),
      });
    }

    const statusCode = (error as any).statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Unhandled error');
      return reply.status(statusCode).send({
        message: 'Внутренняя ошибка сервера',
      });
    }

    reply.status(statusCode).send({
      message: error.message || 'Произошла ошибка',
    });
  });
}
