// apps/api/src/modules/auth/forgot-password.ts
// Эндпоинты запроса сброса пароля (forgot-password) и подтверждения нового пароля (reset-password)

import { FastifyReply, FastifyRequest } from 'fastify';
import argon2 from 'argon2';
import crypto from 'crypto';
import {
  ForgotPasswordDto,
  forgotPasswordSchema,
  ResetPasswordDto,
  resetPasswordSchema,
} from './schemas';
import { sendTelegramMessage } from '../../lib/telegram';
import { config } from '../../config';

const RESET_TOKEN_TTL_SECONDS = 3600; // 1 час

/**
 * POST /auth/forgot-password
 * Принимает email пользователя, генерирует криптостойкий токен сброса пароля,
 * сохраняет его в Redis и отправляет ссылку/уведомление.
 */
export const forgotPasswordHandler = async (
  request: FastifyRequest<{ Body: ForgotPasswordDto }>,
  reply: FastifyReply,
) => {
  const dto = forgotPasswordSchema.parse(request.body);
  const prisma = request.server.prisma;
  const redis = request.server.redis;

  const user = await prisma.user.findUnique({
    where: { email: dto.email.toLowerCase().trim() },
    select: { id: true, email: true, name: true, isBlocked: true },
  });

  // Защита от timing-атак и раскрытия существования аккаунта:
  // Если пользователь не найден или заблокирован, все равно возвращаем успешный ответ
  if (!user || user.isBlocked) {
    request.log.info({ email: dto.email }, 'Password reset requested for nonexistent or blocked user');
    return reply.send({
      message: 'Если аккаунт с таким email существует, ссылка для сброса пароля отправлена.',
    });
  }

  // Генерируем безопасный случайный токен
  const resetToken = crypto.randomBytes(32).toString('hex');
  const redisKey = `pwd_reset:${resetToken}`;

  const payload = {
    userId: user.id,
    email: user.email,
  };

  // Сохраняем в Redis с TTL 1 час
  await redis.set(redisKey, JSON.stringify(payload), 'EX', RESET_TOKEN_TTL_SECONDS);

  // Формируем ссылку на страницу сброса пароля с использованием PUBLIC_SITE_URL и локали пользователя
  const siteBase = (config.PUBLIC_SITE_URL || 'https://ijarauz.uz').replace(/\/+$/, '');
  const userLocale = dto.locale || 'ru';
  const resetLink = `${siteBase}/${userLocale}/reset-password?token=${resetToken}`;

  request.log.info(
    { userId: user.id, locale: userLocale },
    'Password reset link generated',
  );

  // Отправляем уведомление через Telegram, если бот настроен (админу или в канал логов)
  if (config.TELEGRAM_BOT_TOKEN) {
    const adminChatId = config.TELEGRAM_ADMIN_CHAT_ID;
    if (adminChatId) {
      await sendTelegramMessage(
        adminChatId,
        `🔐 <b>Запрос на сброс пароля</b>\n\n` +
        `👤 Пользователь: <b>${user.name}</b> (${user.email})\n` +
        `🌐 Локаль: <code>${userLocale}</code>\n` +
        `<i>Письмо со ссылкой отправлено пользователю, если email-провайдер настроен.</i>`,
        'HTML',
        request.log,
      ).catch(() => {});
    }
  }

  // Если настроен Resend API для отправки почты
  if (config.RESEND_API_KEY) {
    try {
      const emailSubject = userLocale === 'uz'
        ? 'Ijarauz saytida parolni tiklash'
        : userLocale === 'en'
        ? 'Password Reset on Ijarauz'
        : 'Сброс пароля на сайте Ijarauz';

      const emailHeading = userLocale === 'uz'
        ? 'Parolni tiklash'
        : userLocale === 'en'
        ? 'Password Recovery'
        : 'Восстановление пароля';

      const emailGreeting = userLocale === 'uz'
        ? `Assalomu alaykum, ${user.name}!`
        : userLocale === 'en'
        ? `Hello, ${user.name}!`
        : `Здравствуйте, ${user.name}!`;

      const emailBody = userLocale === 'uz'
        ? 'Siz Ijarauz platformasidagi hisobingiz parolini tiklashni so‘radingiz.'
        : userLocale === 'en'
        ? 'You received this email because you requested a password reset for your Ijarauz account.'
        : 'Вы получили это письмо, потому что запросили сброс пароля для своей учетной записи на платформе Ijarauz.';

      const buttonText = userLocale === 'uz'
        ? 'Parolni tiklash'
        : userLocale === 'en'
        ? 'Reset Password'
        : 'Сбросить пароль';

      const emailFooter = userLocale === 'uz'
        ? 'Havola 1 soat davomida amal qiladi. Agar siz so‘rov yubormagan bo‘lsangiz, ushbu xatga e’tibor bermang.'
        : userLocale === 'en'
        ? 'This link is valid for 1 hour. If you did not request this, please ignore this email.'
        : 'Ссылка действительна в течение 1 часа. Если вы не запрашивали смену пароля, просто проигнорируйте это письмо.';

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'Ijarauz Security <noreply@ijarauz.uz>',
          to: [user.email],
          subject: emailSubject,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9fafb; border-radius: 8px;">
              <h2 style="color: #111827;">${emailHeading}</h2>
              <p style="color: #4b5563;">${emailGreeting}</p>
              <p style="color: #4b5563;">${emailBody}</p>
              <div style="margin: 28px 0;">
                <a href="${resetLink}" style="background-color: #2563eb; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
                  ${buttonText}
                </a>
              </div>
              <p style="color: #6b7280; font-size: 14px;">Ссылка: <br><a href="${resetLink}" style="color: #2563eb;">${resetLink}</a></p>
              <p style="color: #9ca3af; font-size: 12px; margin-top: 30px;">${emailFooter}</p>
            </div>
          `,
        }),
      });
    } catch (err) {
      request.log.error({ err }, '[ForgotPassword] Error sending email via Resend');
    }
  } else {
    request.log.warn(
      { userId: user.id, email: user.email },
      '[ForgotPassword] RESEND_API_KEY не настроен — email со ссылкой сброса НЕ отправлен пользователю!',
    );
  }

  return reply.send({
    message: 'Если аккаунт с таким email существует, ссылка для сброса пароля отправлена.',
  });
};

/**
 * POST /auth/reset-password
 * Проверяет валидность токена из Redis, хэширует новый пароль и обновляет запись пользователя в БД.
 */
export const resetPasswordHandler = async (
  request: FastifyRequest<{ Body: ResetPasswordDto }>,
  reply: FastifyReply,
) => {
  const dto = resetPasswordSchema.parse(request.body);
  const prisma = request.server.prisma;
  const redis = request.server.redis;

  const redisKey = `pwd_reset:${dto.token}`;
  const dataStr = await redis.get(redisKey);

  if (!dataStr) {
    return reply.status(400).send({
      message: 'Срок действия ссылки истек или ссылка недействительна. Запросите сброс пароля повторно.',
    });
  }

  let session: { userId: string; email: string };
  try {
    session = JSON.parse(dataStr);
  } catch {
    return reply.status(400).send({
      message: 'Некорректные данные токена сброса пароля.',
    });
  }

  // Хэшируем новый пароль с помощью argon2
  const newPasswordHash = await argon2.hash(dto.password);

  const updatedUser = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: session.userId },
      data: {
        passwordHash: newPasswordHash,
        refreshTokenHash: null,
      },
      select: { id: true, email: true, name: true },
    });
    await tx.authSession.updateMany({
      where: { userId: session.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return user;
  });

  // Удаляем использованный токен из Redis
  await redis.del(redisKey);

  // Записываем аудит-лог
  await prisma.auditLog.create({
    data: {
      userId: updatedUser.id,
      action: 'PASSWORD_RESET_COMPLETED',
      resource: 'user',
      resourceId: updatedUser.id,
      meta: { email: updatedUser.email },
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      timestamp: new Date(),
    },
  }).catch(() => {});

  request.log.info({ userId: updatedUser.id, email: updatedUser.email }, 'Password successfully reset');

  return reply.send({
    message: 'Пароль успешно изменен. Теперь вы можете войти с новым паролем.',
  });
};
