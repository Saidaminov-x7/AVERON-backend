import { Redis } from 'ioredis';
import { startTelegramBot, stopTelegramBot } from '../lib/telegram';

const token = process.env.TELEGRAM_TOKEN_2FA || process.env.TELEGRAM_BOT_TOKEN;
const redisUrl = process.env.REDIS_URL;

if (!token || !redisUrl) {
  throw new Error('TELEGRAM_TOKEN_2FA and REDIS_URL are required for the Telegram worker');
}

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  retryStrategy: (times) => Math.min(times * 250, 5_000),
});
redis.on('error', () => console.error('[Telegram] Redis connection error'));

startTelegramBot(redis);
console.info('[Telegram] Dedicated polling worker started');

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  stopTelegramBot();
  try {
    await redis.quit();
  } finally {
    process.exit(0);
  }
};

process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
