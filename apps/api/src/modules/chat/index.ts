// apps/api/src/modules/chat/index.ts
// Модуль обмена сообщениями и чатов между пользователями (арендатор <-> арендодатель)

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../../lib/authMiddleware';

const sendMessageSchema = z.object({
  recipientId: z.string().uuid(),
  listingId: z.string().uuid().optional().nullable(),
  message: z.string().min(1).max(2000),
});

export const chatModule = async (server: FastifyInstance) => {
  const prisma = server.prisma;

  /**
   * GET /chat/conversations
   * Список всех активных диалогов текущего пользователя
   */
  server.get('/conversations', { preHandler: [authMiddleware] }, async (request, reply) => {
    const userId = request.user.userId;

    // Ищем все сообщения, где пользователь отправитель или получатель
    const allMessages = await prisma.chatMessage.findMany({
      where: {
        OR: [{ senderId: userId }, { recipientId: userId }],
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        sender: {
          select: { id: true, name: true, avatar: true, phone: true },
        },
        recipient: {
          select: { id: true, name: true, avatar: true, phone: true },
        },
        listing: {
          select: {
            id: true,
            title: true,
            city: true,
            price: true,
            images: { select: { url: true }, take: 1 },
          },
        },
      },
    });

    // Группируем по собеседнику (peerId)
    const conversationsMap = new Map<string, any>();

    for (const msg of allMessages) {
      const isSender = msg.senderId === userId;
      const peer = isSender ? msg.recipient : msg.sender;
      const peerId = peer.id;

      if (!conversationsMap.has(peerId)) {
        conversationsMap.set(peerId, {
          id: peerId,
          peerId: peerId,
          peerName: peer.name || 'Пользователь',
          peerAvatar: peer.avatar,
          peerPhone: peer.phone,
          lastMessage: msg.message,
          time: msg.createdAt.toISOString(),
          unread: 0,
          listing: msg.listing
            ? {
                id: msg.listing.id,
                title: msg.listing.title,
                city: msg.listing.city,
                price: Number(msg.listing.price),
                image: msg.listing.images?.[0]?.url || null,
              }
            : null,
        });
      }

      // Считаем непрочитанные входящие
      if (!isSender && msg.readStatus === 'DELIVERED') {
        const conv = conversationsMap.get(peerId);
        if (conv) conv.unread += 1;
      }
    }

    return reply.send(Array.from(conversationsMap.values()));
  });

  /**
   * GET /chat/conversations/:peerId
   * История сообщений с конкретным собеседником
   */
  server.get<{ Params: { peerId: string } }>(
    '/conversations/:peerId',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const userId = request.user.userId;
      const { peerId } = request.params;

      const peer = await prisma.user.findUnique({
        where: { id: peerId },
        select: { id: true, name: true, avatar: true, phone: true },
      });

      if (!peer) {
        return reply.status(404).send({ message: 'Собеседник не найден' });
      }

      const messages = await prisma.chatMessage.findMany({
        where: {
          OR: [
            { senderId: userId, recipientId: peerId },
            { senderId: peerId, recipientId: userId },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: 100,
        include: {
          listing: {
            select: {
              id: true,
              title: true,
              city: true,
              price: true,
              images: { select: { url: true }, take: 1 },
            },
          },
        },
      });

      // Помечаем прочитанными входящие сообщения
      await prisma.chatMessage.updateMany({
        where: {
          senderId: peerId,
          recipientId: userId,
          readStatus: 'DELIVERED',
        },
        data: {
          readStatus: 'READ',
        },
      });

      return reply.send({
        peer: {
          id: peer.id,
          name: peer.name || 'Пользователь',
          avatar: peer.avatar,
          phone: peer.phone,
        },
        messages: messages.map((m) => ({
          id: m.id,
          sender: m.senderId === userId ? 'user' : 'peer',
          senderId: m.senderId,
          recipientId: m.recipientId,
          text: m.message,
          timestamp: m.createdAt.toISOString(),
          readStatus: m.readStatus,
          listingId: m.listingId,
          listing: m.listing
            ? {
                id: m.listing.id,
                title: m.listing.title,
                city: m.listing.city,
                price: Number(m.listing.price),
                image: m.listing.images?.[0]?.url || null,
              }
            : null,
        })),
      });
    },
  );

  /**
   * POST /chat/messages
   * Отправить сообщение собеседнику
   */
  server.post<{ Body: { recipientId: string; listingId?: string | null; message: string } }>(
    '/messages',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const userId = request.user.userId;
      const parsed = sendMessageSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send({
          message: 'Некорректные параметры сообщения',
          errors: parsed.error.flatten().fieldErrors,
        });
      }

      const { recipientId, listingId, message } = parsed.data;

      if (recipientId === userId) {
        return reply.status(400).send({ message: 'Нельзя отправлять сообщения самому себе' });
      }

      const recipient = await prisma.user.findUnique({
        where: { id: recipientId },
        select: { id: true, name: true },
      });

      if (!recipient) {
        return reply.status(404).send({ message: 'Получатель не найден' });
      }

      const created = await prisma.chatMessage.create({
        data: {
          senderId: userId,
          recipientId,
          listingId: listingId || null,
          message: message.trim(),
          readStatus: 'DELIVERED',
        },
        include: {
          listing: {
            select: {
              id: true,
              title: true,
              city: true,
              price: true,
              images: { select: { url: true }, take: 1 },
            },
          },
        },
      });

      return reply.status(201).send({
        id: created.id,
        sender: 'user',
        senderId: created.senderId,
        recipientId: created.recipientId,
        text: created.message,
        timestamp: created.createdAt.toISOString(),
        readStatus: created.readStatus,
        listing: created.listing
          ? {
              id: created.listing.id,
              title: created.listing.title,
              city: created.listing.city,
              price: Number(created.listing.price),
              image: created.listing.images?.[0]?.url || null,
            }
          : null,
      });
    },
  );

  /**
   * PATCH /chat/conversations/:peerId/read
   * Отметить все сообщения от собеседника как прочитанные
   */
  server.patch<{ Params: { peerId: string } }>(
    '/conversations/:peerId/read',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const userId = request.user.userId;
      const { peerId } = request.params;

      await prisma.chatMessage.updateMany({
        where: {
          senderId: peerId,
          recipientId: userId,
          readStatus: 'DELIVERED',
        },
        data: {
          readStatus: 'READ',
        },
      });

      return reply.send({ success: true });
    },
  );

  /**
   * DELETE /chat/messages/:id
   * Удалить сообщение (только автор)
   */
  server.delete<{ Params: { id: string } }>(
    '/messages/:id',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const userId = request.user.userId;
      const { id } = request.params;

      const msg = await prisma.chatMessage.findUnique({
        where: { id },
      });

      if (!msg) {
        return reply.status(404).send({ message: 'Сообщение не найдено' });
      }

      if (msg.senderId !== userId) {
        return reply.status(403).send({ message: 'Вы можете удалять только свои сообщения' });
      }

      await prisma.chatMessage.delete({ where: { id } });
      return reply.send({ success: true });
    },
  );
};
