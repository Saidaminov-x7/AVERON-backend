import type { FastifyReply, FastifyRequest } from 'fastify';

type ErrorWithStatus = {
  statusCode?: unknown;
};

/** Stable public messages for uncaught HTTP errors; never reflect exception text. */
export function safeHttpErrorMessage(statusCode: number): string {
  if (statusCode >= 500) return 'An unexpected error occurred';
  switch (statusCode) {
    case 400: return 'Invalid request';
    case 401: return 'Authentication required';
    case 403: return 'Access denied';
    case 404: return 'Resource not found';
    case 409: return 'Request conflicts with the current resource state';
    case 422: return 'Request could not be processed';
    case 429: return 'Too many requests. Try again later.';
    default: return 'Request could not be completed';
  }
}

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

  return { statusCode, message: safeHttpErrorMessage(statusCode) };
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
