// apps/api/src/modules/pages-public/index.ts
// Публичный эндпоинт для чтения динамических страниц — без авторизации

import { FastifyPluginAsync } from 'fastify';

export const pagesPublicModule: FastifyPluginAsync = async (server) => {
  /**
   * GET /pages/:slug — получить опубликованную страницу по slug
   * Используется основным фронтендом для отображения динамических страниц.
   */
  server.get<{ Params: { slug: string } }>('/:slug', async (request, reply) => {
    const { slug } = request.params;

    const page = await server.prisma.page.findUnique({
      where: { slug },
      select: {
        id: true,
        slug: true,
        title: true,
        content: true,
        locale: true,
        isPublished: true,
        isUnderMaintenance: true,
        createdAt: true,
        updatedAt: true,
        author: { select: { id: true, name: true } },
      },
    });

    if (!page) {
      return reply.status(404).send({ message: 'Page not found' });
    }

    if (!page.isPublished) {
      return reply.status(404).send({ message: 'Page not found' });
    }

    if (page.isUnderMaintenance) {
      return reply.status(503).send({
        message: 'Page is under maintenance',
        maintenanceMessage: 'Эта страница временно недоступна из-за технических работ.',
      });
    }

    return page;
  });
};
