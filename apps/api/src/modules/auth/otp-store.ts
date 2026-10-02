import type { Redis } from 'ioredis';

const consumeOtpScript = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return {0} end
local payload = cjson.decode(encoded)
if tonumber(payload.attempts or 0) >= 5 then
  redis.call('DEL', KEYS[1])
  return {2}
end
if payload.codeHash ~= ARGV[1] then
  payload.attempts = tonumber(payload.attempts or 0) + 1
  redis.call('SET', KEYS[1], cjson.encode(payload), 'KEEPTTL')
  return {1}
end
redis.call('DEL', KEYS[1])
return {3, encoded}
`;

export async function consumeHashedOtp(redis: Redis, key: string, codeHash: string) {
  const result: unknown = await redis.eval(consumeOtpScript, 1, key, codeHash);
  const values = Array.isArray(result) ? result : [result];
  return {
    status: Number(values[0]),
    payload: values[1] === undefined ? undefined : String(values[1]),
  };
}
