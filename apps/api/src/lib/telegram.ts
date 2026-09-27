// apps/api/src/lib/telegram.ts
// Telegram Bot сервис для 2FA аутентификации супер-администратора

import { Redis } from 'ioredis';
import { FastifyBaseLogger } from 'fastify';
import { config } from '../config';

function getTelegramApiBase(): string | null {
  const token = config.TELEGRAM_TOKEN_2FA || config.TELEGRAM_BOT_TOKEN;
  return token ? `https://api.telegram.org/bot${token}` : null;
}

const REDIS_CHAT_ID_KEY = 'telegram:admin:chat_id';

let pollingActive = false;
let lastUpdateId = 0;
let pollingTimeout: NodeJS.Timeout | null = null;

/**
 * Отправка сообщения в Telegram
 */
export async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  parseMode: 'HTML' | 'Markdown' = 'HTML',
  logger?: FastifyBaseLogger,
): Promise<boolean> {
  const apiBase = getTelegramApiBase();
  if (!apiBase) {
    if (logger) {
      logger.warn('[Telegram] TELEGRAM_TOKEN_2FA is not configured. Message skipped.');
    }
    return false;
  }

  try {
    const res = await fetch(`${apiBase}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
      }),
    });
    const json = (await res.json()) as { ok: boolean; description?: string };
    if (!json.ok) {
      if (logger) {
        logger.error({ description: json.description }, '[Telegram] Failed to send message');
      }
    }
    return json.ok;
  } catch (err) {
    if (logger) {
      logger.error({ err }, '[Telegram] Error sending message');
    }
    return false;
  }
}

/**
 * Получить сохраненный Chat ID администратора
 */
export async function getAdminChatId(redis: Redis): Promise<string | null> {
  if (config.TELEGRAM_ADMIN_CHAT_ID) {
    return config.TELEGRAM_ADMIN_CHAT_ID;
  }
  return await redis.get(REDIS_CHAT_ID_KEY);
}

/**
 * Отправить одноразовый код 2FA для входа в супер-админку
 */
export async function sendTelegram2FACode(
  redis: Redis,
  code: string,
  adminEmail: string,
  ip?: string,
): Promise<{ success: boolean; message?: string }> {
  const chatId = await getAdminChatId(redis);

  if (!chatId) {
    return {
      success: false,
      message: 'Telegram Chat ID не настроен. Напишите /start боту в Telegram для привязки аккаунта.',
    };
  }

  const timeString = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const message = `
🔐 <b>Код подтверждения для входа в AVERON Admin</b>

Ваш одноразовый код: <code>${code}</code>

👤 <b>Аккаунт:</b> ${adminEmail}
⏰ <b>Время:</b> ${timeString}
🌐 <b>IP-адрес:</b> ${ip || 'не определен'}

⏳ <i>Код действителен в течение 5 минут. Никому не сообщайте этот код!</i>
`.trim();

  const sent = await sendTelegramMessage(chatId, message, 'HTML');
  return { success: sent };
}

/**
 * Запуск Long Polling для обработки команд бота (/start)
 */
export function startTelegramBot(redis: Redis, logger?: FastifyBaseLogger) {
  if (!config.TELEGRAM_TOKEN_2FA && !config.TELEGRAM_BOT_TOKEN) {
    logger?.warn('[Telegram] TELEGRAM_TOKEN_2FA not configured. Bot polling skipped.');
    return;
  }

  pollingActive = true;
  logger?.info('[Telegram] Starting Telegram 2FA Bot polling listener...');

  const poll = async () => {
    if (!pollingActive) return;

    const apiBase = getTelegramApiBase();
    if (!apiBase) return;

    try {
      const res = await fetch(`${apiBase}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`, {
        signal: AbortSignal.timeout(35000),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          ok: boolean;
          result: Array<{
            update_id: number;
            message?: {
              chat: { id: number; username?: string; first_name?: string };
              text?: string;
              from?: { id: number; username?: string; first_name?: string };
            };
          }>;
        };

        if (data.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            lastUpdateId = Math.max(lastUpdateId, update.update_id);

            const msg = update.message;
            if (!msg || !msg.text) continue;

            const text = msg.text.trim();
            const chatId = msg.chat.id;
            const firstName = msg.from?.first_name || 'Администратор';

            // Если владелец задан в Railway, бот полностью игнорирует всех остальных.
            if (config.TELEGRAM_ADMIN_CHAT_ID && String(chatId) !== config.TELEGRAM_ADMIN_CHAT_ID) {
              logger?.warn({ chatId }, '[Telegram] Ignored message from unauthorized chat');
              continue;
            }

            if (text.startsWith('/start')) {
              const currentBoundId = await redis.get(REDIS_CHAT_ID_KEY);
              // Всегда актуализируем chat ID
              await redis.set(REDIS_CHAT_ID_KEY, String(chatId));

              // Отправляем подтверждение только один раз, если не был привязан этот же chat_id
              if (currentBoundId !== String(chatId)) {
                logger?.info({ chatId, username: msg.from?.username }, '[Telegram] Admin registered new chat ID for 2FA');
                const welcomeMsg = `
👋 Здравствуйте, <b>${firstName}</b>!

✅ <b>Ваш Telegram успешно привязан к системе безопасности AVERON!</b>
Ваш Chat ID (<code>${chatId}</code>) сохранен в системе.
Теперь бот будет присылать 6-значные коды 2FA только при попытке входа в админ-панель.
`.trim();
                await sendTelegramMessage(chatId, welcomeMsg, 'HTML');
              }
            } else if (text.startsWith('/status')) {
              const savedChatId = await redis.get(REDIS_CHAT_ID_KEY);
              const isBound = savedChatId === String(chatId);
              if (isBound) {
                await sendTelegramMessage(
                  chatId,
                  `✅ Бот активен и привязан. Коды 2FA отправляются сюда автоматически.`,
                  'HTML',
                );
              }
            }
          }
        }
      }
    } catch (err: unknown) {
      // Игнорируем штатный таймаут fetch long-polling
      const error = err as Error;
      if (error.name !== 'TimeoutError' && error.name !== 'AbortError') {
        logger?.debug({ err: error.message }, '[Telegram] Polling loop notice');
      }
    }

    if (pollingActive) {
      pollingTimeout = setTimeout(poll, 1000);
    }
  };

  poll();
}

/**
 * Остановка бота при завершении работы сервера
 */
export function stopTelegramBot() {
  pollingActive = false;
  if (pollingTimeout) {
    clearTimeout(pollingTimeout);
    pollingTimeout = null;
  }
}
