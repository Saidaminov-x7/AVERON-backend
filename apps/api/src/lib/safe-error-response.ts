import type { FastifyReply, FastifyRequest } from 'fastify';

type ErrorWithStatus = {
  statusCode?: unknown;
  message?: unknown;
};

export function toSafeErrorResponse(
  error: unknown,
  internalMessage = 'An internal error occurred',
): { statusCode: number; message: string } {
  const candidate = error as ErrorWithStatus | null;
  const requestedStatus = candidate && typeof candidate === 'object'
    ? candidate.statusCode
    : undefined;
  const statusCode = typeof requestedStatus === 'number'
    && Number.isInteger(requestedStatus)
    && requestedStatus >= 400
    && requestedStatus < 600
    ? requestedStatus
    : 500;

  if (statusCode >= 500) {
    return { statusCode, message: internalMessage };
  }

  const message = candidate && typeof candidate.message === 'string'
    ? candidate.message
    : 'Request could not be completed';
  return { statusCode, message };
}

export function sendSafeErrorReply(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  logMessage: string,
  internalMessage?: string,
) {
  const safe = toSafeErrorResponse(error, internalMessage);
  if (safe.statusCode >= 500) {
    request.log.error(
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
      logMessage,
    );
  }
  return reply.status(safe.statusCode).send({ message: safe.message });
}
