import type { FastifyInstance } from 'fastify';

export function registerNotFoundHandler(server: FastifyInstance): void {
  server.setNotFoundHandler((_request, reply) => reply.status(404).send({
    statusCode: 404,
    error: 'Not Found',
    message: 'Route not found',
  }));
}
