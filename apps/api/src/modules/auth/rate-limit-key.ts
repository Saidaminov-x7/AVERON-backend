import { createHmac } from 'node:crypto';

export const MAX_RATE_LIMIT_IDENTIFIER_LENGTH = 512;

function normalizeIdentity(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().slice(0, MAX_RATE_LIMIT_IDENTIFIER_LENGTH)
    : '';
}

export function createAuthRateLimitKey(
  secret: string,
  scope: string,
  sourceIp: string,
  identityFields: readonly unknown[] = [],
): string {
  const identity = identityFields.map(normalizeIdentity);
  const material = JSON.stringify({
    scope: scope.slice(0, 64),
    sourceIp: sourceIp.slice(0, MAX_RATE_LIMIT_IDENTIFIER_LENGTH),
    identityFields: identity,
  });
  const digest = createHmac('sha256', secret).update(material).digest('hex');
  return `averon:v1:auth:${scope.slice(0, 64)}:${digest}`;
}
