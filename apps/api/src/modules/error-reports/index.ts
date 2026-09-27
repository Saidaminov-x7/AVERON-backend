import { FastifyPluginAsync } from 'fastify';
import { adminMiddleware } from '../../lib/adminMiddleware';
import { createErrorReportSchema, errorReportFilterSchema } from './schemas';

export const errorReportsModule: FastifyPluginAsync = async (server) => {
  /**
   * POST /error-reports — публичный эндпоинт для отправки клиентских ошибок с фронтенда
   */
  server.post(
    '/',
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const parsed = createErrorReportSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ message: 'Invalid payload', errors: parsed.error.format() });
      }

      const { message, stack, url, userAgent, userId, severity } = parsed.data;

      try {
        const report = await server.prisma.clientErrorReport.create({
          data: {
            message,
            stack: stack || undefined,
            url,
            userAgent: userAgent || (typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : undefined),
            userId: userId || undefined,
            severity,
            ip: request.ip,
          },
        });

        // Создаем AdminNotification для информирования администраторов
        await server.prisma.adminNotification.create({
          data: {
            type: 'CLIENT_ERROR',
            title: 'Ошибка на сайте',
            message: message.slice(0, 200),
            link: `/errors`,
          },
        }).catch(() => {});

        return reply.status(201).send({ id: report.id });
      } catch (err) {
        request.log.warn({ err }, 'Failed to save client error report');
        return reply.status(500).send({ message: 'Failed to record error report' });
      }
    },
  );

  /**
   * GET /error-reports — список ошибок для админ-панели (требует прав ADMIN)
   */
  server.get('/', { preHandler: [adminMiddleware] }, async (request, reply) => {
    const filter = errorReportFilterSchema.parse(request.query);
    const { page, limit, severity, resolved } = filter;

    const where: any = {};
    if (severity) where.severity = severity;
    if (resolved !== undefined) where.resolved = resolved;

    const [items, total] = await server.prisma.$transaction([
      server.prisma.clientErrorReport.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      server.prisma.clientErrorReport.count({ where }),
    ]);

    return {
      items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  });

  /**
   * PATCH /error-reports/:id/resolve — пометить ошибку как решённую
   */
  server.patch<{ Params: { id: string } }>('/:id/resolve', { preHandler: [adminMiddleware] }, async (request, reply) => {
    const { id } = request.params;
    try {
      const updated = await server.prisma.clientErrorReport.update({
        where: { id },
        data: { resolved: true },
      });
      return { success: true, item: updated };
    } catch (err) {
      return reply.status(404).send({ message: 'Error report not found' });
    }
  });
};
