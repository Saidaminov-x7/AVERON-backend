import { Prisma, TelegramPublicationStatus } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { adminMiddleware } from '../../lib/adminMiddleware';
import { config } from '../../config';
import { featureFlags } from '../features/feature-flags';
import { buildTelegramCard, sendTelegramCard, TelegramPublishError, type TelegramCardProduct } from './telegram-publisher';

const productParams = z.object({ id: z.string().uuid() });
const previewBody = z.object({
  captionOverride: z.string().trim().max(700).optional(),
}).strict();

const productSelect = {
  id: true,
  slug: true,
  status: true,
  translations: true,
  description: true,
  salePriceUzs: true,
  stock: true,
  preorderEnabled: true,
  preorderLimit: true,
  preorderReserved: true,
  preorderEstimatedAt: true,
  images: { orderBy: { sortOrder: 'asc' as const }, take: 1, select: { url: true } },
  variants: { select: { stock: true, active: true } },
} satisfies Prisma.CommerceProductSelect;

async function getPublishedProduct(app: Parameters<FastifyPluginAsync>[0], id: string) {
  const product = await app.prisma.commerceProduct.findUnique({
    where: { id },
    select: productSelect,
  });
  return product;
}

export const telegramPublicationModule: FastifyPluginAsync = async (app) => {
  app.get('/admin/products/:id/telegram-publication', { preHandler: adminMiddleware }, async (request, reply) => {
    const { id } = productParams.parse(request.params);
    const product = await getPublishedProduct(app, id);
    if (!product) return reply.status(404).send({ code: 'PRODUCT_NOT_FOUND' });
    const channelId = config.TELEGRAM_CHANNEL_ID?.trim() || null;
    const publication = channelId
      ? await app.prisma.commerceTelegramPublication.findUnique({
        where: { productId_channelId: { productId: id, channelId } },
        select: {
          status: true,
          telegramMessageId: true,
          publishedAt: true,
          lastAttemptAt: true,
          errorCode: true,
          attemptCount: true,
          captionOverride: true,
        },
      })
      : null;
    return {
      featureEnabled: featureFlags.isEnabled('TELEGRAM_PRODUCT_PUBLISH'),
      configured: Boolean(channelId && config.TELEGRAM_MINI_APP_BOT_TOKEN?.trim()),
      channelId,
      status: publication?.status ?? TelegramPublicationStatus.NOT_PUBLISHED,
      telegramMessageId: publication?.telegramMessageId ?? null,
      publishedAt: publication?.publishedAt ?? null,
      lastAttemptAt: publication?.lastAttemptAt ?? null,
      errorCode: publication?.errorCode ?? null,
      attemptCount: publication?.attemptCount ?? 0,
      captionOverride: publication?.captionOverride ?? '',
    };
  });

  app.post('/admin/products/:id/telegram-preview', { preHandler: adminMiddleware }, async (request, reply) => {
    const { id } = productParams.parse(request.params);
    const input = previewBody.parse(request.body ?? {});
    const product = await getPublishedProduct(app, id);
    if (!product) return reply.status(404).send({ code: 'PRODUCT_NOT_FOUND' });
    if (product.status !== 'PUBLISHED') return reply.status(409).send({ code: 'PRODUCT_NOT_PUBLISHED' });
    try {
      const card = buildTelegramCard(product as TelegramCardProduct, input);
      await app.prisma.auditLog.create({
        data: {
          userId: request.user.userId,
          action: 'TELEGRAM_PRODUCT_PREVIEWED',
          resource: 'CommerceProduct',
          resourceId: id,
          meta: { slug: product.slug },
        },
      });
      return { ...card, channelId: config.TELEGRAM_CHANNEL_ID?.trim() || null };
    } catch (error) {
      if (error instanceof TelegramPublishError) {
        return reply.status(400).send({ code: error.code });
      }
      throw error;
    }
  });

  app.post('/admin/products/:id/telegram-publish', {
    preHandler: adminMiddleware,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!featureFlags.isEnabled('TELEGRAM_PRODUCT_PUBLISH')) {
      return reply.status(409).send({ code: 'FEATURE_DISABLED' });
    }
    const { id } = productParams.parse(request.params);
    const input = previewBody.parse(request.body ?? {});
    const channelId = config.TELEGRAM_CHANNEL_ID?.trim();
    if (!channelId || !config.TELEGRAM_MINI_APP_BOT_TOKEN?.trim()) {
      return reply.status(503).send({ code: 'TELEGRAM_NOT_CONFIGURED' });
    }

    const product = await getPublishedProduct(app, id);
    if (!product) return reply.status(404).send({ code: 'PRODUCT_NOT_FOUND' });
    if (product.status !== 'PUBLISHED') return reply.status(409).send({ code: 'PRODUCT_NOT_PUBLISHED' });

    let publication = await app.prisma.commerceTelegramPublication.upsert({
      where: { productId_channelId: { productId: id, channelId } },
      create: { productId: id, channelId, createdById: request.user.userId },
      update: {},
      select: { id: true, status: true, telegramMessageId: true, errorCode: true },
    });
    if (
      publication.status === TelegramPublicationStatus.FAILED &&
      publication.errorCode === 'TELEGRAM_DELIVERY_UNCONFIRMED'
    ) {
      return reply.status(409).send({
        code: 'PUBLICATION_UNCONFIRMED',
        status: publication.status,
      });
    }
    const claimed = await app.prisma.commerceTelegramPublication.updateMany({
      where: {
        id: publication.id,
        status: { in: [TelegramPublicationStatus.NOT_PUBLISHED, TelegramPublicationStatus.FAILED] },
      },
      data: {
        status: TelegramPublicationStatus.PUBLISHING,
        captionOverride: input.captionOverride ?? null,
        lastAttemptAt: new Date(),
        lastAttemptById: request.user.userId,
        errorCode: null,
        attemptCount: { increment: 1 },
      },
    });
    if (claimed.count !== 1) {
      publication = await app.prisma.commerceTelegramPublication.findUniqueOrThrow({
        where: { id: publication.id },
        select: { id: true, status: true, telegramMessageId: true, errorCode: true },
      });
      return reply.status(409).send({
        code: publication.status === TelegramPublicationStatus.PUBLISHED ? 'ALREADY_PUBLISHED' : 'PUBLICATION_IN_PROGRESS',
        status: publication.status,
        telegramMessageId: publication.telegramMessageId,
      });
    }

    await app.prisma.auditLog.create({
      data: {
        userId: request.user.userId,
        action: 'TELEGRAM_PRODUCT_PUBLISH_ATTEMPTED',
        resource: 'CommerceTelegramPublication',
        resourceId: publication.id,
        meta: { productId: id, channelId, retry: publication.status === TelegramPublicationStatus.FAILED },
      },
    });

    let messageId: string;
    try {
      const card = buildTelegramCard(product as TelegramCardProduct, input);
      messageId = await sendTelegramCard(card, channelId);
    } catch (error) {
      const errorCode = error instanceof TelegramPublishError ? error.code : 'TELEGRAM_PUBLISH_FAILED';
      await app.prisma.commerceTelegramPublication.update({
        where: { id: publication.id },
        data: { status: TelegramPublicationStatus.FAILED, errorCode },
      });
      await app.prisma.auditLog.create({
        data: {
          userId: request.user.userId,
          action: 'TELEGRAM_PRODUCT_PUBLISH_FAILED',
          resource: 'CommerceTelegramPublication',
          resourceId: publication.id,
          meta: { productId: id, channelId, errorCode },
        },
      });
      request.log.error({ publicationId: publication.id, errorCode }, 'Telegram product publication failed');
      return reply.status(502).send({ code: errorCode, status: TelegramPublicationStatus.FAILED });
    }

    const publishedAt = new Date();
    const updated = await app.prisma.commerceTelegramPublication.update({
      where: { id: publication.id },
      data: {
        status: TelegramPublicationStatus.PUBLISHED,
        telegramMessageId: messageId,
        publishedAt,
        errorCode: null,
        captionOverride: input.captionOverride ?? null,
        lastAttemptById: request.user.userId,
      },
      select: { status: true, telegramMessageId: true, publishedAt: true, attemptCount: true },
    });
    await app.prisma.auditLog.create({
      data: {
        userId: request.user.userId,
        action: 'TELEGRAM_PRODUCT_PUBLISHED',
        resource: 'CommerceTelegramPublication',
        resourceId: publication.id,
        meta: { productId: id, channelId, telegramMessageId: messageId },
      },
    });
    return updated;
  });
};
