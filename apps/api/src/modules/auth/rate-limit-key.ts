import { createHmac } from 'node:crypto';

const MAX_RATE_LIMIT_IDENTIFIER_LENGTH = 256;

/** Build a stable Redis key without retaining source IPs or submitted identifiers. */
export function createAuthRateLimitKey(
  secret: string,
  scope: string,
  sourceIp: string,
  body: unknown,
  identityFields: readonly string[],
  caseInsensitive = false,
): string {
  const values = typeof body === 'object' && body !== null && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  let identity = 'unknown';

  for (const field of identityFields) {
    const value = values[field];
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    const trimmed = value.trim();
    identity = trimmed.length <= MAX_RATE_LIMIT_IDENTIFIER_LENGTH ? trimmed : 'invalid-length';
    if (identity === 'invalid-length') break;
    if (caseInsensitive) identity = identity.toLowerCase();
    break;
  }

  const digest = createHmac('sha256', secret)
    .update(scope)
    .update('\0')
    .update(sourceIp)
    .update('\0')
    .update(identity)
    .digest('hex');

  return `auth:${scope}:${digest}`;
}
