// apps/api/src/modules/ai-chat/index.ts

import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../../lib/authMiddleware';
import { AIChatService } from './service';
import { PublicAIService } from './public-service';
import { sendMessageSchema, createSessionSchema, SendMessageDto, CreateSessionDto } from './schemas';
import { config } from '../../config';

export const aiChatModule: FastifyPluginAsync = async (server) => {
  const getService = (req: FastifyRequest) => new AIChatService(req.server.prisma);
  const publicService = new PublicAIService(server.prisma);
  const phoneUserOnly = async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await request.server.prisma.user.findUnique({
      where: { id: request.user.userId },
      select: { phone: true, isBlocked: true },
    });
    if (!user?.phone || user.isBlocked) {
      return reply.status(403).send({
        message: 'AVERON AI доступен только активным пользователям, вошедшим по номеру телефона',
      });
    }
  };

  server.post<{ Body: { message: string; history?: Array<{ role: 'user' | 'assistant'; content: string }> } }>('/chat', {
    preHandler: [authMiddleware, phoneUserOnly],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, // Строже для AI
  }, async (request, reply) => {
    const message = request.body?.message?.trim();
    if (!message || message.length > 2000) {
      return reply.status(400).send({ message: 'Message must contain 1-2000 characters' });
    }
    try {
      return reply.send(await publicService.chat(message, request.body.history));
    } catch (err) {
      server.log.error({ err }, 'Public AI chat error');
      return reply.status(503).send({ message: 'AI-сервис временно недоступен' });
    }
  });

  /**
   * POST /ai-chat/sessions — создать сессию
   */
  server.post<{ Body: CreateSessionDto }>('/sessions', {
    preHandler: [authMiddleware, phoneUserOnly],
  }, async (request, reply) => {
    const dto = createSessionSchema.parse(request.body ?? {});
    const service = getService(request);
    const session = await service.createSession(request.user.userId, dto.title);
    return reply.status(201).send(session);
  });

  /**
   * GET /ai-chat/sessions — список сессий
   */
  server.get('/sessions', {
    preHandler: [authMiddleware, phoneUserOnly],
  }, async (request: FastifyRequest, _reply: FastifyReply) => {
    const service = getService(request);
    const sessions = await service.getSessions(request.user.userId);
    return sessions;
  });

  /**
   * GET /ai-chat/sessions/:sessionId — история сообщений
   */
  server.get<{ Params: { sessionId: string } }>('/sessions/:sessionId', {
    preHandler: [authMiddleware, phoneUserOnly],
  }, async (
    request,
    reply,
  ) => {
    const service = getService(request);
    try {
      const messages = await service.getSessionMessages(
        request.params.sessionId,
        request.user.userId,
      );
      return messages;
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * DELETE /ai-chat/sessions/:sessionId — удалить сессию
   */
  server.delete<{ Params: { sessionId: string } }>('/sessions/:sessionId', {
    preHandler: [authMiddleware, phoneUserOnly],
  }, async (
    request,
    reply,
  ) => {
    const service = getService(request);
    try {
      await service.deleteSession(request.params.sessionId, request.user.userId);
      return reply.status(204).send();
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      return reply.status(error.statusCode ?? 500).send({ message: error.message });
    }
  });

  /**
   * POST /ai-chat/message — отправить сообщение (обычный ответ)
   */
  server.post<{ Body: SendMessageDto }>('/message', {
    preHandler: [authMiddleware, phoneUserOnly],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const dto = sendMessageSchema.parse(request.body);
    const service = getService(request);

    try {
      const result = await service.sendMessage(
        request.user.userId,
        dto.message,
        dto.sessionId,
        dto.model,
      );
      return reply.send({
        sessionId: result.session.id,
        response: result.response,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      server.log.error({ err }, 'AI chat error');
      return reply.status(error.statusCode ?? 503).send({
        message: error.statusCode ? error.message : 'AI-сервис временно недоступен. Пожалуйста, повторите попытку позже.',
      });
    }
  });

  /**
   * POST /ai-chat/stream — стриминг ответа (SSE)
   */
  server.post<{ Body: SendMessageDto }>('/stream', {
    preHandler: [authMiddleware, phoneUserOnly],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const dto = sendMessageSchema.parse(request.body);
    const service = getService(request);

    // Устанавливаем SSE заголовки
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders();

    try {
      const stream = service.streamMessage(
        request.user.userId,
        dto.message,
        dto.sessionId,
        dto.model,
      );

      for await (const chunk of stream) {
        const data = JSON.stringify({ content: chunk });
        reply.raw.write(`data: ${data}\n\n`);
      }

      reply.raw.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    } catch (err) {
      const error = err as Error;
      server.log.error({ err }, 'AI stream error');
      reply.raw.write(`data: ${JSON.stringify({ error: error.message || 'AI-сервис временно недоступен' })}\n\n`);
    } finally {
      reply.raw.end();
    }
  });

  /**
   * GET /chats/:listingId/summary — AI-суммаризация переписки по объявлению
   */
  server.get<{ Params: { listingId: string } }>('/chats/:listingId/summary', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const userId = request.user.userId;
    const { listingId } = request.params;

    const messages = await request.server.prisma.chatMessage.findMany({
      where: {
        listingId,
        OR: [{ senderId: userId }, { recipientId: userId }],
      },
      include: {
        sender: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });

    if (messages.length === 0) {
      return reply.send({ summary: 'Переписка по данному объявлению пока пуста.' });
    }

    const transcript = messages.map((m) => `${m.sender.name}: ${m.message}`).join('\n');

    try {
      const response = await fetch(`${config.OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          model: config.OLLAMA_MODEL,
          messages: [
            { role: 'system', content: 'Кратко суммируй переписку между арендодателем и арендатором в 2-3 предложениях на русском языке.' },
            { role: 'user', content: transcript },
          ],
          stream: false,
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as { message?: { content?: string } };
        if (data.message?.content) {
          return reply.send({ summary: data.message.content });
        }
      }
    } catch {
      // Fallback при отсутствии связки с Ollama
    }

    const uniqueSenders = Array.from(new Set(messages.map((m) => m.sender.name)));
    return reply.send({
      summary: `Диалог из ${messages.length} сообщений между ${uniqueSenders.join(' и ')}. Обсуждаются вопросы аренды и условий заезда.`,
    });
  });
};
