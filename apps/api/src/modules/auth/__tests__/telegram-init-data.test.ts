import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyTelegramInitData } from '../telegram-init-data';

const botToken = 'test-only-telegram-bot-token';
const now = 1_800_000_000;

function signedInitData(
  user: Record<string, unknown> = { id: 123456789, first_name: 'Averon', username: 'averon_user' },
  authDate = now,
) {
  const fields = new URLSearchParams({
    auth_date: String(authDate),
    query_id: 'AAE-test-query',
    user: JSON.stringify(user),
  });
  const dataCheckString = [...fields.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  fields.set('hash', createHmac('sha256', secretKey).update(dataCheckString).digest('hex'));
  return fields.toString();
}

describe('Telegram Mini App initData verification', () => {
  it('accepts a valid, fresh Telegram signature and returns only verified identity fields', () => {
    expect(verifyTelegramInitData(signedInitData(), botToken, now)).toEqual({
      id: '123456789',
      firstName: 'Averon',
      username: 'averon_user',
    });
  });

  it('rejects altered data and invalid hashes', () => {
    const altered = new URLSearchParams(signedInitData());
    altered.set('user', JSON.stringify({ id: 123456789, first_name: 'Attacker' }));
    expect(verifyTelegramInitData(altered.toString(), botToken, now)).toBeNull();
    altered.set('hash', '0'.repeat(64));
    expect(verifyTelegramInitData(altered.toString(), botToken, now)).toBeNull();
  });

  it('rejects stale, future-dated, malformed, and ambiguous initData', () => {
    expect(verifyTelegramInitData(signedInitData(undefined, now - 301), botToken, now)).toBeNull();
    expect(verifyTelegramInitData(signedInitData(undefined, now + 31), botToken, now)).toBeNull();
    expect(verifyTelegramInitData('auth_date=not-a-date&user=%7B', botToken, now)).toBeNull();
    expect(verifyTelegramInitData(`${signedInitData()}&auth_date=${now}`, botToken, now)).toBeNull();
    expect(verifyTelegramInitData(signedInitData({ id: 0, first_name: 'Bad' }), botToken, now)).toBeNull();
  });
});
