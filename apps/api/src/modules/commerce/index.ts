import type { FastifyPluginAsync } from 'fastify';
import { ProductPublicationStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { adminMiddleware } from '../../lib/adminMiddleware';
import { authMiddleware } from '../../lib/authMiddleware';
import { adminProductListQuerySchema, approveImportSchema, createImportSchema, createManualProductSchema, customOrderSchema, productListQuerySchema, rejectImportSchema, updateProductCountrySchema } from './schemas';
import { assertHumanApproval, slugifyProduct } from './rules';
import { publishProductToTelegram } from './telegram-publisher';

type ProductListQuery = ReturnType<typeof productListQuerySchema.parse>;

export function buildProductWhere(
  query: ProductListQuery,
  status: ProductPublicationStatus = ProductPublicationStatus.PUBLISHED,
): Prisma.CommerceProductWhereInput {
  const where: Prisma.CommerceProductWhereInput = { status };
  if (query.country) where.country = query.country;
  if (query.category) where.category = { slug: query.category };
  if (query.audience) where.attributes = { path: ['audience'], equals: query.audience };
  if (query.size || query.color) {
    where.variants = {
      some: {
        active: true,
        ...(query.size ? { size: query.size } : {}),
        ...(query.color ? { color: { equals: query.color, mode: 'insensitive' } } : {}),
      },
    };
  }
  if (query.minPrice || query.maxPrice) {
    where.salePriceUzs = {
      ...(query.minPrice ? { gte: query.minPrice } : {}),
      ...(query.maxPrice ? { lte: query.maxPrice } : {}),
    };
  }
  if (query.q?.trim()) {
    const q = query.q.trim();
    where.OR = [
      { id: { equals: q } },
      { slug: { contains: q, mode: 'insensitive' } },
      { material: { contains: q, mode: 'insensitive' } },
    ];
  }
  return where;
}

function productOrderBy(sort?: string): Prisma.CommerceProductOrderByWithRelationInput {
  if (sort === 'price_asc') return { salePriceUzs: 'asc' };
  if (sort === 'price_desc') return { salePriceUzs: 'desc' };
  return { publishedAt: 'desc' };
}

const localizedTitle = (translations: unknown, fallback: string): string => {
  if (!translations || typeof translations !== 'object') return fallback;
  const data = translations as Record<string, unknown>;
  for (const locale of ['ru', 'uz', 'en']) {
    const value = data[locale];
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).title === 'string') return (value as { title: string }).title;
  }
  return fallback;
};

export const commerceModule: FastifyPluginAsync = async (app) => {
  app.get('/products', async (request) => {
    const query = productListQuerySchema.parse(request.query);
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(48, Math.max(1, Number(query.limit) || 24));
    const where = buildProductWhere(query);
    const [items, total] = await Promise.all([
      app.prisma.commerceProduct.findMany({ where, include: { images: { orderBy: { sortOrder: 'asc' }, take: 3 }, variants: { where: { active: true } }, category: true }, orderBy: productOrderBy(query.sort), skip: (page - 1) * limit, take: limit }),
      app.prisma.commerceProduct.count({ where }),
    ]);
    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  });

  app.get('/products/:identifier', async (request, reply) => {
    const { identifier } = request.params as { identifier: string };
    const product = await app.prisma.commerceProduct.findFirst({ where: { OR: [{ slug: identifier }, { id: identifier }], status: 'PUBLISHED' }, include: { images: { orderBy: { sortOrder: 'asc' } }, variants: { where: { active: true } }, category: true } });
    return product ?? reply.status(404).send({ message: 'Товар не найден' });
  });

  app.get('/categories', async () => app.prisma.commerceCategory.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { slug: 'asc' }] }));

  app.post('/custom-orders', async (request, reply) => {
    const input = customOrderSchema.parse(request.body);
    const item = await app.prisma.customOrderRequest.create({ data: { ...input, contact: input.contact as any, selectedVariant: input.selectedVariant as any } });
    return reply.status(201).send(item);
  });

  app.get('/orders/me', { preHandler: authMiddleware }, async (request) => {
    return app.prisma.commerceOrder.findMany({
      where: { userId: request.user.userId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        currency: true,
        totalRevenue: true,
        createdAt: true,
        updatedAt: true,
        items: { select: { id: true, title: true, quantity: true, unitPrice: true, totalPrice: true, productId: true } },
        statusHistory: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  });

  app.get('/admin/dashboard', { preHandler: adminMiddleware }, async () => {
    const [published, pendingReview, rejected, orders, users, revenue, expenses] = await Promise.all([
      app.prisma.commerceProduct.count({ where: { status: 'PUBLISHED' } }),
      app.prisma.importedProduct.count({ where: { status: 'PENDING_REVIEW' } }),
      app.prisma.importedProduct.count({ where: { status: 'REJECTED' } }),
      app.prisma.commerceOrder.count(),
      app.prisma.user.count({ where: { isDeleted: false } }),
      app.prisma.commerceOrder.aggregate({ _sum: { totalRevenue: true, netProfit: true } }),
      app.prisma.commerceExpense.aggregate({ _sum: { amount: true } }),
    ]);
    return { products: { published, pendingReview, rejected }, orders: { total: orders }, users: { total: users }, finance: { revenue: revenue._sum.totalRevenue ?? 0, netProfit: revenue._sum.netProfit ?? 0, expenses: expenses._sum.amount ?? 0 } };
  });

  app.get('/admin/products', { preHandler: adminMiddleware }, async (request) => {
    const query = adminProductListQuerySchema.parse(request.query);
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(48, Math.max(1, Number(query.limit) || 24));
    const where = buildProductWhere(query, query.status ?? ProductPublicationStatus.PUBLISHED);
    const [items, total] = await Promise.all([
      app.prisma.commerceProduct.findMany({
        where,
        include: { images: { orderBy: { sortOrder: 'asc' }, take: 3 }, variants: { where: { active: true } }, category: true },
        orderBy: productOrderBy(query.sort),
        skip: (page - 1) * limit,
        take: limit,
      }),
      app.prisma.commerceProduct.count({ where }),
    ]);
    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  });

  app.get('/admin/imports', { preHandler: adminMiddleware }, async (request) => {
    const query = request.query as { status?: string };
    return app.prisma.importedProduct.findMany({ where: query.status ? { status: query.status as any } : undefined, include: { category: true, product: true }, orderBy: { createdAt: 'desc' }, take: 100 });
  });

  app.post('/admin/products', { preHandler: adminMiddleware }, async (request, reply) => {
    const input = createManualProductSchema.parse(request.body);
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const product = await app.prisma.commerceProduct.create({ data: {
      slug: `${slugifyProduct(input.title)}-${suffix}`.slice(0, 190),
      country: input.country,
      translations: { ru: { title: input.title }, uz: { title: input.titleUz || input.title }, en: { title: input.titleEn || input.title } },
      description: input.description ? { ru: input.description } : undefined,
      attributes: { audience: 'everyone' }, source: 'MANUAL', sourceProductId: suffix, sourceUrl: input.sourceUrl,
      originalPriceCny: input.sourcePriceCny, exchangeRate: input.exchangeRate, salePriceUzs: input.salePriceUzs,
      categoryId: input.categoryId, approvedById: request.user.userId, approvedAt: new Date(), status: input.publish ? 'PUBLISHED' : 'DRAFT', publishedAt: input.publish ? new Date() : null,
      images: input.imageUrl ? { create: [{ url: input.imageUrl, alt: { ru: input.title } }] } : undefined,
      variants: input.color || input.size ? { create: [{ sku: `MANUAL-${suffix}`, color: input.color, size: input.size, sourcePriceCny: input.sourcePriceCny, salePriceUzs: input.salePriceUzs, stock: 1 }] } : undefined,
    }, include: { images: true, variants: true } });
    await app.prisma.auditLog.create({ data: { userId: request.user.userId, action: 'PRODUCT_MANUALLY_CREATED', resource: 'CommerceProduct', resourceId: product.id, meta: { published: input.publish } } });
    if (input.publish) publishProductToTelegram(product, input.imageUrl).catch((error) => app.log.error({ error, productId: product.id }, 'Telegram product publication failed'));
    return reply.status(201).send(product);
  });

  app.put('/admin/products/:id', { preHandler: adminMiddleware }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = updateProductCountrySchema.parse(request.body);
    const product = await app.prisma.commerceProduct.findUnique({ where: { id }, select: { id: true } });
    if (!product) return reply.status(404).send({ message: 'Товар не найден' });

    return app.prisma.$transaction(async (tx) => {
      const updatedProduct = await tx.commerceProduct.update({
        where: { id },
        data: { country: input.country },
      });
      await tx.auditLog.create({
        data: {
          userId: request.user.userId,
          action: 'PRODUCT_COUNTRY_UPDATED',
          resource: 'CommerceProduct',
          resourceId: id,
          meta: { country: input.country },
        },
      });
      return updatedProduct;
    });
  });

  app.post('/admin/imports', { preHandler: adminMiddleware }, async (request, reply) => {
    const input = createImportSchema.parse(request.body);
    const item = await app.prisma.importedProduct.upsert({
      where: { source_sourceProductId: { source: input.source, sourceProductId: input.sourceProductId } },
      create: { ...input, status: 'PENDING_REVIEW', normalizedPayload: input.normalizedPayload as any, aiPayload: input.aiPayload as any, aiWarnings: input.aiWarnings as any },
      update: { sourceUrl: input.sourceUrl, sourcePriceCny: input.sourcePriceCny, normalizedPayload: input.normalizedPayload as any, aiPayload: input.aiPayload as any, aiWarnings: input.aiWarnings as any, status: 'PENDING_REVIEW' },
    });
    return reply.status(201).send(item);
  });

  app.post('/admin/imports/:id/approve', { preHandler: adminMiddleware }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = approveImportSchema.parse(request.body);
    const imported = await app.prisma.importedProduct.findUnique({ where: { id } });
    if (!imported) return reply.status(404).send({ message: 'Импорт не найден' });
    assertHumanApproval(imported.status, request.user.userId);
    const title = localizedTitle(input.translations ?? imported.aiPayload, imported.originalTitle);
    const baseSlug = input.slug ?? slugifyProduct(title);
    const result = await app.prisma.$transaction(async (tx) => {
      const product = await tx.commerceProduct.create({ data: {
        slug: `${baseSlug}-${imported.sourceProductId}`.slice(0, 190),
        country: input.country,
        translations: (input.translations ?? imported.aiPayload ?? { ru: { title } }) as any,
        source: imported.source, sourceProductId: imported.sourceProductId, sourceUrl: imported.sourceUrl,
        originalPriceCny: imported.sourcePriceCny, exchangeRate: input.exchangeRate, salePriceUzs: input.salePriceUzs,
        categoryId: imported.categoryId, importedFromId: imported.id, approvedById: request.user.userId,
        approvedAt: new Date(), status: input.publish ? 'PUBLISHED' : 'DRAFT', publishedAt: input.publish ? new Date() : null,
      } });
      await tx.importedProduct.update({ where: { id }, data: { status: 'APPROVED', reviewedById: request.user.userId, reviewedAt: new Date() } });
      await tx.auditLog.create({ data: { userId: request.user.userId, action: 'PRODUCT_IMPORT_APPROVED', resource: 'ImportedProduct', resourceId: id, meta: { productId: product.id, published: input.publish } } });
      return product;
    });
    if (input.publish) {
      const payload = imported.normalizedPayload as Record<string, any> | null;
      const imageUrl = payload?.images?.[0]?.url || payload?.images?.[0];
      publishProductToTelegram(result, typeof imageUrl === 'string' ? imageUrl : undefined).catch((error) => app.log.error({ error, productId: result.id }, 'Telegram product publication failed'));
    }
    return result;
  });

  app.post('/admin/imports/:id/reject', { preHandler: adminMiddleware }, async (request) => {
    const { id } = request.params as { id: string };
    const input = rejectImportSchema.parse(request.body);
    const imported = await app.prisma.importedProduct.findUniqueOrThrow({ where: { id } });
    assertHumanApproval(imported.status, request.user.userId);
    return app.prisma.$transaction(async (tx) => {
      const item = await tx.importedProduct.update({ where: { id }, data: { status: 'REJECTED', rejectionReason: input.reason, reviewedById: request.user.userId, reviewedAt: new Date() } });
      await tx.auditLog.create({ data: { userId: request.user.userId, action: 'PRODUCT_IMPORT_REJECTED', resource: 'ImportedProduct', resourceId: id, meta: { reason: input.reason } } });
      return item;
    });
  });

  app.get('/admin/orders', { preHandler: adminMiddleware }, async () => app.prisma.commerceOrder.findMany({ include: { items: true, payments: true, purchases: true }, orderBy: { createdAt: 'desc' }, take: 100 }));
};
