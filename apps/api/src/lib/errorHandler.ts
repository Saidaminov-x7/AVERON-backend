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

    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      const diagnosticStage = (error as FastifyError & { diagnosticStage?: string }).diagnosticStage;
      if (diagnosticStage) {
        request.log.error({
          requestId: request.id,
          diagnosticStage,
          method: request.method,
          route: request.routeOptions.url,
          errorType: error.name,
          errorCode: (error as FastifyError & { code?: string }).code,
        }, `Request failed during ${diagnosticStage}`);
      } else {
        request.log.error({
          err: error,
          requestId: request.id,
          method: request.method,
          route: request.routeOptions.url,
        }, 'Unhandled request error');
      }
      return reply.status(statusCode).send({
        message: 'Внутренняя ошибка сервера',
        requestId: request.id,
      });
    }

    reply.status(statusCode).send({
      message: error.message || 'Произошла ошибка',
    });
  });
}
