// apps/api/src/modules/ai-chat/service.ts

import { PrismaClient, AISession, AIChatMessage } from '@prisma/client';
import { config } from '../../config';

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream: boolean;
  options?: {
    temperature?: number;
    num_ctx?: number;
  };
}

interface OllamaChatResponse {
  message: {
    role: string;
    content: string;
  };
  done: boolean;
}

const SYSTEM_PROMPT = `Ты — умный AI-помощник платформы аренды недвижимости Ijarauz.uz в Узбекистане.
Помогаешь пользователям:
- Найти подходящее жильё (квартиры, дома, комнаты, коммерческие помещения)
- Разобраться в условиях аренды, договорах
- Дать совет по районам городов Узбекистана (Ташкент, Самарканд, Бухара и др.)
- Ответить на вопросы о ценах, инфраструктуре, транспорте

Отвечай кратко, дружелюбно и по делу. Если вопрос не связан с недвижимостью — вежливо перенаправь.
Отвечай на том языке, на котором задан вопрос (русский, узбекский, английский).`;

export class AIChatService {
  constructor(private readonly prisma: PrismaClient) { }

  /**
   * Создать новую сессию чата
   */
  async createSession(userId: string, title?: string): Promise<AISession> {
    return this.prisma.aISession.create({
      data: {
        userId,
        title: title ?? 'Новый чат',
      },
    });
  }

  /**
   * Получить все сессии пользователя (IDOR: только сессии текущего пользователя)
   */
  async getSessions(userId: string): Promise<AISession[]> {
    return this.prisma.aISession.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: { select: { messages: true } },
      },
    });
  }

  /**
   * Получить историю сообщений сессии с проверкой владения
   */
  async getSessionMessages(sessionId: string, userId: string): Promise<AIChatMessage[]> {
    const session = await this.prisma.aISession.findFirst({
      where: { id: sessionId, userId },
    });
    if (!session) throw Object.assign(new Error('Session not found'), { statusCode: 404 });

    return this.prisma.aIChatMessage.findMany({
      where: { sessionId },
      orderBy: { timestamp: 'asc' },
    });
  }

  /**
   * Отправить сообщение и получить ответ от Ollama (без стриминга)
   */
  async sendMessage(
    userId: string,
    userMessage: string,
    sessionId: string | undefined,
    model: string,
  ): Promise<{ session: AISession; message: AIChatMessage; response: string }> {
    let session: AISession;
    if (sessionId) {
      const found = await this.prisma.aISession.findFirst({
        where: { id: sessionId, userId },
      });
      if (!found) throw Object.assign(new Error('Session not found'), { statusCode: 404 });
      session = found;
    } else {
      session = await this.createSession(userId);
    }

    // Загружаем историю (последние 20 сообщений для контекста)
    const history = await this.prisma.aIChatMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { timestamp: 'asc' },
      take: 20,
    });

    const messages: OllamaMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.map((msg) => ({
        role: (msg.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
        content: msg.content,
      })),
      { role: 'user', content: userMessage },
    ];

    // Запрос к Ollama с таймаутом и обработкой сбоев
    const aiResponse = await this.callOllama({
      model,
      messages,
      stream: false,
      options: { temperature: 0.7, num_ctx: 4096 },
    });

    const responseText = aiResponse.message.content;

    // Сохраняем сообщение пользователя
    const savedMessage = await this.prisma.aIChatMessage.create({
      data: {
        sessionId: session.id,
        role: 'user',
        content: userMessage,
        model,
      },
    });

    // Сохраняем ответ AI
    await this.prisma.aIChatMessage.create({
      data: {
        sessionId: session.id,
        role: 'assistant',
        content: responseText,
        model,
      },
    });

    // Обновляем timestamp сессии
    await this.prisma.aISession.update({
      where: { id: session.id },
      data: { updatedAt: new Date() },
    });

    return { session, message: savedMessage, response: responseText };
  }

  /**
   * Удалить сессию с проверкой владения
   */
  async deleteSession(sessionId: string, userId: string): Promise<void> {
    const session = await this.prisma.aISession.findFirst({
      where: { id: sessionId, userId },
    });
    if (!session) throw Object.assign(new Error('Session not found'), { statusCode: 404 });

    await this.prisma.aISession.delete({ where: { id: sessionId } });
  }

  /**
   * Вызов Ollama API с circuit breaker и таймаутом 20 секунд
   */
  private async callOllama(body: OllamaChatRequest): Promise<OllamaChatResponse> {
    const url = `${config.OLLAMA_BASE_URL}/api/chat`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000), // 20 секунд таймаут для избежания зависания
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw Object.assign(
          new Error(`Ollama API error (${response.status}): ${text || 'AI model error'}`),
          { statusCode: 503 },
        );
      }

      return (await response.json()) as OllamaChatResponse;
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      if (error.statusCode) throw error;

      // Ошибка подключения (Ollama выключена или таймаут)
      throw Object.assign(
        new Error('AI-сервис временно недоступен. Пожалуйста, повторите попытку позже.'),
        { statusCode: 503 },
      );
    }
  }

  /**
   * Стриминг ответа от Ollama (SSE)
   */
  async *streamMessage(
    userId: string,
    userMessage: string,
    sessionId: string | undefined,
    model: string,
  ): AsyncGenerator<string> {
    let session: AISession;
    if (sessionId) {
      const found = await this.prisma.aISession.findFirst({
        where: { id: sessionId, userId },
      });
      if (!found) throw Object.assign(new Error('Session not found'), { statusCode: 404 });
      session = found;
    } else {
      session = await this.createSession(userId);
    }

    const history = await this.prisma.aIChatMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { timestamp: 'asc' },
      take: 20,
    });

    const properMessages: OllamaMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.map((msg) => ({
        role: (msg.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
        content: msg.content,
      })),
      { role: 'user', content: userMessage },
    ];

    // Сохраняем сообщение пользователя
    await this.prisma.aIChatMessage.create({
      data: { sessionId: session.id, role: 'user', content: userMessage, model },
    });

    const url = `${config.OLLAMA_BASE_URL}/api/chat`;
    let response: Response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: properMessages, stream: true }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!response.ok || !response.body) {
        throw Object.assign(
          new Error('AI-сервис временно недоступен. Пожалуйста, повторите попытку позже.'),
          { statusCode: 503 },
        );
      }
    } catch {
      throw Object.assign(
        new Error('AI-сервис временно недоступен. Пожалуйста, повторите попытку позже.'),
        { statusCode: 503 },
      );
    }

    let fullResponse = '';
    const decoder = new TextDecoder();

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      const text = decoder.decode(chunk, { stream: true });
      const lines = text.split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as OllamaChatResponse;
          if (parsed.message?.content) {
            fullResponse += parsed.message.content;
            yield parsed.message.content;
          }
        } catch {
          // Игнорируем неполные куски JSON
        }
      }
    }

    if (fullResponse.trim().length > 0) {
      // Сохраняем полный ответ
      await this.prisma.aIChatMessage.create({
        data: { sessionId: session.id, role: 'assistant', content: fullResponse, model },
      });

      await this.prisma.aISession.update({
        where: { id: session.id },
        data: { updatedAt: new Date() },
      });
    }
  }
}
