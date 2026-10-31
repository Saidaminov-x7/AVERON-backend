import { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { isTrustedCookieOrigin } from './cors-origins';

export function createTrustedCookieOriginGuard(allowedOrigins: ReadonlySet<string>): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isTrustedCookieOrigin(request.headers.origin, allowedOrigins)) {
      return reply.status(403).send({ message: 'Untrusted request origin' });
    }
  };
}
