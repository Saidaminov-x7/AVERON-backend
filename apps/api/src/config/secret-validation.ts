import { createHash, timingSafeEqual } from 'node:crypto';

const DENIED_REFRESH_SECRET_SHA256 = [
  '5c7fae0afdf76b3718a28af6359d7f1c514eb42e4dd4e2f9cd4ae6b5f35c4df2',
] as const;

export function isDeniedRefreshSecret(secret: string): boolean {
  if (/^your_refresh_secret(?:_|$)/i.test(secret)) return true;

  const candidateHash = createHash('sha256').update(secret).digest();
  return DENIED_REFRESH_SECRET_SHA256.some((knownHash) =>
    timingSafeEqual(candidateHash, Buffer.from(knownHash, 'hex')),
  );
}
