import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerifiedTelegramUser {
  id: string;
  username?: string;
  firstName: string;
  lastName?: string;
}

export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds = 300,
): VerifiedTelegramUser | null {
  if (!initData || initData.length > 4096 || !botToken.trim()) return null;
  const params = new URLSearchParams(initData);
  const fields = [...params.keys()];
  if (new Set(fields).size !== fields.length) return null;
  const suppliedHash = params.get('hash');
  const authDateRaw = params.get('auth_date');
  const userRaw = params.get('user');
  if (!suppliedHash || !/^[a-f0-9]{64}$/i.test(suppliedHash) || !authDateRaw || !userRaw) return null;

  const authDate = Number(authDateRaw);
  if (!Number.isSafeInteger(authDate) || authDate > nowSeconds + 30 || nowSeconds - authDate > maxAgeSeconds) return null;
  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = createHmac('sha256', secretKey).update(dataCheckString).digest();
  const actualHash = Buffer.from(suppliedHash, 'hex');
  if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) return null;

  let value: unknown;
  try {
    value = JSON.parse(userRaw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const user = value as Record<string, unknown>;
  const id = user.id;
  if (
    !(typeof id === 'number' && Number.isSafeInteger(id) && id > 0) &&
    !(typeof id === 'string' && /^\d{1,20}$/.test(id) && BigInt(id) > 0n)
  ) return null;
  if (typeof user.first_name !== 'string' || !user.first_name.trim() || user.first_name.length > 128) return null;
  if (user.last_name !== undefined && (typeof user.last_name !== 'string' || user.last_name.length > 128)) return null;
  if (user.username !== undefined && (typeof user.username !== 'string' || !/^[A-Za-z0-9_]{1,32}$/.test(user.username))) return null;

  return {
    id: String(id),
    firstName: user.first_name.trim(),
    ...(typeof user.last_name === 'string' && user.last_name ? { lastName: user.last_name } : {}),
    ...(typeof user.username === 'string' ? { username: user.username } : {}),
  };
}
