export interface SafeErrorResponse {
  statusCode: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503;
  message: string;
}

export function safeHttpErrorMessage(statusCode: number): string {
  if (statusCode in SAFE_MESSAGES) return SAFE_MESSAGES[statusCode as SafeErrorResponse['statusCode']];
  return statusCode >= 500
    ? 'An unexpected error occurred.'
    : 'The request could not be processed.';
}

const SAFE_MESSAGES: Record<SafeErrorResponse['statusCode'], string> = {
  400: 'Invalid request.',
  401: 'Authentication is required.',
  403: 'Access denied.',
  404: 'Resource not found.',
  409: 'The request conflicts with the current resource state.',
  413: 'The request is too large.',
  429: 'Too many requests. Try again later.',
  503: 'The service is temporarily unavailable. Please try again later.',
};

export function toSafeErrorResponse(error: unknown, fallbackStatus: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503 = 503): SafeErrorResponse {
  const candidate = error && typeof error === 'object' && 'statusCode' in error
    ? (error as { statusCode?: unknown }).statusCode
    : undefined;
  const statusCode = typeof candidate === 'number' && candidate in SAFE_MESSAGES
    ? candidate as SafeErrorResponse['statusCode']
    : fallbackStatus;
  return { statusCode, message: safeHttpErrorMessage(statusCode) };
}
