import type { FastifyInstance, FastifyRequest } from 'fastify';

export function registerNotFoundHandler(
  server: FastifyInstance,
  isRestricted?: (request: FastifyRequest) => Promise<boolean>,
): void {
  server.setNotFoundHandler(async (request, reply) => {
    if (await isRestricted?.(request)) {
      return reply.status(429).send({
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'Too many requests. Try again later.',
      });
    }
    return reply.status(404).send({
      statusCode: 404,
      error: 'Not Found',
      message: 'Route not found',
    });
  });
}
