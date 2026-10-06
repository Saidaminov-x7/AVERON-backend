import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Prisma, ProductPublicationStatus } from '@prisma/client';
import { adminMiddleware } from '../../lib/adminMiddleware';
import { adminImportListQuerySchema, adminProductListQuerySchema, approveImportSchema, createCategorySchema, createImportSchema, createManualProductSchema, customOrderSchema, productListQuerySchema, rejectImportSchema, updateCategorySchema, updateManualProductSchema } from './schemas';
import { assertHumanApproval, createProductWithUniquePublicId, ProductPublicIdCollisionError, slugifyProduct } from './rules';
import { featureFlags } from '../features/feature-flags';
import { parserImportModule } from './parser-import';
import { dispatchDomainEvent } from '../integrations/domain-events';
import { cartCheckoutModule } from './cart-checkout';
import { commerceOrdersModule } from './orders';
import { telegramPublicationModule } from './telegram-publication';
import { productReviewsModule } from './product-reviews';
import { catalogAssistantModule } from './catalog-assistant';
import { publicProductDto } from './public-product-dto';
import { createRecommendationsModule } from './recommendations';
import { outfitsModule } from './outfits';
import { wishlistModule } from './wishlist';
import { commercePromosModule } from './commerce-promos';
import { ipostShippingModule } from './ipost-shipping';

type ProductListQuery = ReturnType<typeof productListQuerySchema.parse>;

export function buildProductWhere(
  query: ProductListQuery,
  status?: ProductPublicationStatus,
): Prisma.CommerceProductWhereInput {
  const where: Prisma.CommerceProductWhereInput = {};
  if (status) where.status = status;
  if (query.country) where.country = query.country;
  if (query.category) where.category = { slug: query.category, active: true };
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
  if (query.minPrice !== undefined || query.maxPrice !== undefined) {
    where.salePriceUzs = {
      ...(query.minPrice ? { gte: query.minPrice } : {}),
      ...(query.maxPrice ? { lte: query.maxPrice } : {}),
    };
  }
  if (query.q?.trim()) {
    const tokens = query.q.trim().split(/\s+/).filter(Boolean).slice(0, 6);
    where.AND = tokens.map((token) => ({
      OR: [
        { id: { equals: token } },
        { slug: { contains: token, mode: 'insensitive' } },
        { material: { contains: token, mode: 'insensitive' } },
        ...(['ru', 'uz', 'en'] as const).flatMap((locale) => [
          { translations: { path: [locale, 'title'], string_contains: token } },
          { translations: { path: [locale], string_contains: token } },
        ]),
      ],
    }));
  }
  return where;
}

function productOrderBy(sort?: string): Prisma.CommerceProductOrderByWithRelationInput {
  if (sort === 'price_asc') return { salePriceUzs: 'asc' };
  if (sort === 'price_desc') return { salePriceUzs: 'desc' };
  return { publishedAt: 'desc' };
}

export function buildPopularProductWhere(where: Prisma.CommerceProductWhereInput): Prisma.CommerceProductWhereInput {
  return {
    AND: [where, { OR: [{ categoryId: null }, { category: { is: { active: true } } }] }],
  };
}

export function rankPopularProductIds(
  candidates: Array<{ id: string; publishedAt: Date | null }>,
  favoriteCounts: Map<string, number>,
  viewCounts: Map<string, number>,
) {
  return candidates
    .sort((left, right) =>
      ((favoriteCounts.get(right.id) ?? 0) * 2 + (viewCounts.get(right.id) ?? 0))
        - ((favoriteCounts.get(left.id) ?? 0) * 2 + (viewCounts.get(left.id) ?? 0)) ||
      (right.publishedAt?.getTime() ?? 0) - (left.publishedAt?.getTime() ?? 0) ||
      left.id.localeCompare(right.id),
    )
    .map(({ id }) => id);
}

async function withDiagnosticStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error) {
      Object.assign(error, { diagnosticStage: stage });
    }
    throw error;
  }
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

function isJsonObject(value: unknown): value is Prisma.InputJsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function copyJsonObject(value: unknown): Record<string, Prisma.InputJsonValue | null> {
  const result: Record<string, Prisma.InputJsonValue | null> = {};
  if (!isJsonObject(value)) return result;
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = item as Prisma.InputJsonValue | null;
  }
  return result;
}

function mergeLocalizedTitles(
  existing: Prisma.JsonValue,
  updates: Partial<Record<'ru' | 'uz' | 'en', string>>,
): Prisma.InputJsonObject {
  const translations = copyJsonObject(existing);
  for (const [locale, title] of Object.entries(updates)) {
    if (title === undefined) continue;
    const currentValue = translations[locale];
    const localized = isJsonObject(currentValue)
      ? copyJsonObject(currentValue)
      : typeof currentValue === 'string'
        ? { title: currentValue }
        : {};
    localized.title = title;
    translations[locale] = localized;
  }
  return translations as Prisma.InputJsonObject;
}

function mergeLocalizedDescriptions(
  existing: Prisma.JsonValue | null,
  updates: Partial<Record<'ru' | 'uz' | 'en', string>>,
): Prisma.InputJsonObject {
  const descriptions = copyJsonObject(existing);
  for (const [locale, description] of Object.entries(updates)) {
    if (description === undefined) continue;
    if (description.trim()) descriptions[locale] = description.trim();
    else delete descriptions[locale];
  }
  return descriptions as Prisma.InputJsonObject;
}

export const commerceModule: FastifyPluginAsync = async (app) => {
  app.register(createRecommendationsModule());
  app.register(parserImportModule);
  app.register(cartCheckoutModule);
  app.register(commerceOrdersModule);
  app.register(telegramPublicationModule);
  app.register(productReviewsModule);
  app.register(catalogAssistantModule);
  app.register(outfitsModule);
  app.register(wishlistModule);
  app.register(commercePromosModule);
  app.register(ipostShippingModule);
  app.get('/products', async (request) => {
    const query = productListQuerySchema.parse(request.query);
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(48, Math.max(1, Number(query.limit) || 24));
    const where = buildProductWhere(query, ProductPublicationStatus.PUBLISHED);
    if (query.sort === 'popular') {
      const eligibleWhere = buildPopularProductWhere(where);
      const [candidates, total] = await Promise.all([
        app.prisma.commerceProduct.findMany({
          where: eligibleWhere,
          select: { id: true, publishedAt: true },
        }),
        app.prisma.commerceProduct.count({ where: eligibleWhere }),
      ]);
      const candidateIds = candidates.map(({ id }) => id);
      if (!candidateIds.length) {
        return { items: [], pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
      }
      const [favorites, views] = await Promise.all([
        app.prisma.productFavorite.groupBy({
          by: ['productId'],
          where: { productId: { in: candidateIds } },
          _count: { _all: true },
        }),
        app.prisma.commerceAnalyticsEvent.groupBy({
          by: ['productId'],
          where: {
            productId: { in: candidateIds },
            eventName: 'product_view',
            createdAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
            productViewDayKey: { not: null },
          },
          _count: { _all: true },
        }),
      ]);
      const favoriteCounts = new Map<string, number>();
      const viewCounts = new Map<string, number>();
      for (const { productId, _count } of favorites) {
        favoriteCounts.set(productId, _count._all);
      }
      for (const { productId, _count } of views) {
        if (productId) viewCounts.set(productId, _count._all);
      }
      const orderedIds = rankPopularProductIds(candidates, favoriteCounts, viewCounts)
        .slice((page - 1) * limit, page * limit)
      const pageProducts = await app.prisma.commerceProduct.findMany({
        where: { id: { in: orderedIds } },
        include: { images: { orderBy: { sortOrder: 'asc' }, take: 3 }, variants: { where: { active: true } }, category: true },
      });
      const productsById = new Map(pageProducts.map((product) => [product.id, product]));
      return {
        items: orderedIds.flatMap((id) => {
          const product = productsById.get(id);
          return product ? [publicProductDto(product)] : [];
        }),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      };
    }
    const [items, total] = await Promise.all([
      app.prisma.commerceProduct.findMany({ where, include: { images: { orderBy: { sortOrder: 'asc' }, take: 3 }, variants: { where: { active: true } }, category: true }, orderBy: productOrderBy(query.sort), skip: (page - 1) * limit, take: limit }),
      app.prisma.commerceProduct.count({ where }),
    ]);
    return { items: items.map(publicProductDto), pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  });

  app.get('/products/:identifier', async (request, reply) => {
    const { identifier } = request.params as { identifier: string };
    const product = await app.prisma.commerceProduct.findFirst({ where: { OR: [{ publicId: identifier }, { slug: identifier }, { id: identifier }], status: 'PUBLISHED' }, include: { images: { orderBy: { sortOrder: 'asc' } }, variants: { where: { active: true } }, category: true } });
    return product ? publicProductDto(product) : reply.status(404).send({ message: 'Товар не найден' });
  });

  app.get('/categories', async () => app.prisma.commerceCategory.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { slug: 'asc' }] }));

  app.get('/catalog-facets', async () => {
    const publishedVariants = {
      active: true,
      product: { is: { status: ProductPublicationStatus.PUBLISHED } },
    };
    const [sizes, colors] = await Promise.all([
      app.prisma.commerceProductVariant.findMany({
        where: { ...publishedVariants, size: { not: null } },
        select: { size: true },
        distinct: ['size'],
        orderBy: { size: 'asc' },
        take: 200,
      }),
      app.prisma.commerceProductVariant.findMany({
        where: { ...publishedVariants, color: { not: null } },
        select: { color: true },
        distinct: ['color'],
        orderBy: { color: 'asc' },
        take: 200,
      }),
    ]);
    return {
      sizes: sizes.map((variant) => variant.size?.trim()).filter((value): value is string => Boolean(value)),
      colors: colors.map((variant) => variant.color?.trim()).filter((value): value is string => Boolean(value)),
    };
  });

  app.get('/admin/categories', { preHandler: adminMiddleware }, async () =>
    app.prisma.commerceCategory.findMany({
      include: { parent: { select: { id: true, slug: true, name: true } }, _count: { select: { products: true, imports: true } } },
      orderBy: [{ sortOrder: 'asc' }, { slug: 'asc' }],
    }));

  app.post('/admin/categories', { preHandler: adminMiddleware }, async (request, reply) => {
    const input = createCategorySchema.parse(request.body);
    if (input.parentId) {
      const parent = await app.prisma.commerceCategory.findUnique({ where: { id: input.parentId }, select: { id: true, active: true } });
      if (!parent || !parent.active) return reply.status(400).send({ message: 'Parent category must be active' });
    }
    const baseSlug = slugifyProduct(input.name.en || input.name.ru || input.name.uz).slice(0, 90);
    const generatedSlug = !input.slug;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const slug = input.slug ?? (attempt === 0 ? baseSlug : `${baseSlug}-${randomUUID().slice(0, 6)}`);
      try {
        return reply.status(201).send(await app.prisma.commerceCategory.create({
          data: { ...input, slug, name: input.name as Prisma.InputJsonValue },
        }));
      } catch (error) {
        if ((error as { code?: string }).code !== 'P2002') throw error;
        if (!generatedSlug) return reply.status(409).send({ message: 'Category slug already exists' });
        if (attempt === 4) return reply.status(409).send({ message: 'Could not generate a unique category slug' });
      }
    }
    return reply.status(409).send({ message: 'Could not generate a unique category slug' });
  });

  app.put<{ Params: { id: string } }>('/admin/categories/:id', { preHandler: adminMiddleware }, async (request, reply) => {
    const input = updateCategorySchema.parse(request.body);
    const current = await app.prisma.commerceCategory.findUnique({ where: { id: request.params.id } });
    if (!current) return reply.status(404).send({ message: 'Category not found' });

    if (input.parentId) {
      let parentId: string | null = input.parentId;
      const visited = new Set<string>();
      while (parentId) {
        if (parentId === current.id || visited.has(parentId)) {
          return reply.status(400).send({ message: 'Category hierarchy cannot contain a cycle' });
        }
        visited.add(parentId);
        const parent: { id: string; active: boolean; parentId: string | null } | null = await app.prisma.commerceCategory.findUnique({
          where: { id: parentId },
          select: { id: true, active: true, parentId: true },
        });
        if (!parent || !parent.active) return reply.status(400).send({ message: 'Parent category must be active' });
        parentId = parent.parentId;
      }
    }

    const oldName = current.name && typeof current.name === 'object' && !Array.isArray(current.name)
      ? current.name as Record<string, unknown>
      : {};
    try {
      return await app.prisma.commerceCategory.update({
        where: { id: current.id },
        data: {
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.name !== undefined ? { name: { ...oldName, ...input.name } as Prisma.InputJsonValue } : {}),
          ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
          ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
        },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        return reply.status(409).send({ message: 'Category slug already exists' });
      }
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>('/admin/categories/:id', { preHandler: adminMiddleware }, async (request, reply) => {
    const current = await app.prisma.commerceCategory.findUnique({ where: { id: request.params.id } });
    if (!current) return reply.status(404).send({ message: 'Category not found' });
    return app.prisma.commerceCategory.update({ where: { id: current.id }, data: { active: false } });
  });

  app.post('/custom-orders', async (request, reply) => {
    const input = customOrderSchema.parse(request.body);
    const item = await app.prisma.customOrderRequest.create({ data: { ...input, contact: input.contact as any, selectedVariant: input.selectedVariant as any } });
    return reply.status(201).send(item);
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
    const where = buildProductWhere(query, query.status);
    if (query.source) where.source = query.source;
    const [items, total] = await Promise.all([
      app.prisma.commerceProduct.findMany({
        where,
        include: {
          images: { orderBy: { sortOrder: 'asc' } },
          variants: { where: { active: true } },
          category: true,
          importedFrom: { select: { originalTitle: true, status: true, source: true } },
          _count: { select: { favoriteLinks: true, recentlyViewedRecords: true, reviews: true } },
        },
        orderBy: productOrderBy(query.sort),
        skip: (page - 1) * limit,
        take: limit,
      }),
      app.prisma.commerceProduct.count({ where }),
    ]);
    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  });

  app.get<{ Params: { identifier: string } }>('/admin/products/:identifier', { preHandler: adminMiddleware }, async (request, reply) => {
    const identifier = request.params.identifier;
    const product = await app.prisma.commerceProduct.findFirst({
      where: { OR: [{ id: identifier }, { publicId: identifier }, { slug: identifier }] },
      include: {
        images: { orderBy: { sortOrder: 'asc' } },
        variants: { where: { active: true } },
        category: true,
        importedFrom: { select: { originalTitle: true, status: true, source: true } },
        _count: { select: { favoriteLinks: true, recentlyViewedRecords: true, reviews: true } },
      },
    });
    return product ?? reply.status(404).send({ message: 'Product not found' });
  });

  app.get('/admin/imports', { preHandler: adminMiddleware }, async (request) => {
    const query = adminImportListQuerySchema.parse(request.query);
    const where: Prisma.ImportedProductWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.provider ? { source: query.provider } : {}),
      ...(query.country ? { normalizedPayload: { path: ['country'], equals: query.country } } : {}),
      ...(query.q ? { OR: [
        { originalTitle: { contains: query.q, mode: 'insensitive' } },
        { sourceProductId: { contains: query.q, mode: 'insensitive' } },
      ] } : {}),
      ...(query.from || query.to ? { createdAt: {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      } } : {}),
    };
    const [items, total] = await Promise.all([
      app.prisma.importedProduct.findMany({
        where,
        include: { category: true, product: true },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      app.prisma.importedProduct.count({ where }),
    ]);
    return { items, pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) } };
  });

  app.post('/admin/products', { preHandler: adminMiddleware }, async (request, reply) => {
    const input = createManualProductSchema.parse(request.body);
    const mediaIds = input.images.map((image) => image.mediaId).filter((id): id is string => Boolean(id));
    const settings = await withDiagnosticStage('manual_product_settings_lookup', () =>
      app.prisma.siteSettings.findUnique({
        where: { id: 'singleton' },
        select: { maxProductPhotos: true, maxProductPhotoSizeMb: true },
      }));
    const maxPhotos = Math.min(15, settings?.maxProductPhotos ?? 15);
    const maxPhotoBytes = Math.min(25, settings?.maxProductPhotoSizeMb ?? 10) * 1024 * 1024;
    if (input.images.length > maxPhotos) {
      return reply.status(400).send({ message: `A product can have at most ${maxPhotos} photos` });
    }
    if (input.categoryId) {
      const category = await withDiagnosticStage('manual_product_category_lookup', () =>
        app.prisma.commerceCategory.findUnique({
          where: { id: input.categoryId },
          select: { id: true, active: true },
        }));
      if (!category?.active) {
        return reply.status(400).send({ message: 'The selected category is not active' });
      }
    }
    const media = await withDiagnosticStage('manual_product_media_lookup', () =>
      app.prisma.media.findMany({ where: { id: { in: mediaIds } } }));
    if (media.length !== mediaIds.length || media.some((image) => image.size > maxPhotoBytes)) {
      return reply.status(400).send({ message: 'One or more product photos are missing or exceed the configured file size limit' });
    }
    const mediaById = new Map(media.map((image) => [image.id, image]));
    const descriptions = {
      ...(input.description?.trim() ? { ru: input.description.trim() } : {}),
      ...(input.descriptionUz?.trim() ? { uz: input.descriptionUz.trim() } : {}),
      ...(input.descriptionEn?.trim() ? { en: input.descriptionEn.trim() } : {}),
    };
    const sourceProductId = randomUUID();
    let product;
    try {
      product = await withDiagnosticStage('manual_product_transaction', () =>
        createProductWithUniquePublicId(input.title, (publicId, slug) => app.prisma.$transaction(async (tx) => {
        const created = await tx.commerceProduct.create({ data: {
          slug,
          publicId,
          country: input.country,
          sizeChartType: input.sizeChartType ?? null,
          translations: { ru: { title: input.title }, uz: { title: input.titleUz }, en: { title: input.titleEn } },
          description: Object.keys(descriptions).length ? descriptions : undefined,
          attributes: { audience: 'everyone' },
          source: 'MANUAL',
          sourceProductId,
          sourceUrl: input.sourceUrl ?? null,
          originalPriceCny: input.sourcePriceCny ?? null,
          exchangeRate: input.exchangeRate ?? null,
          salePriceUzs: input.salePriceUzs,
          compareAtPriceUzs: input.compareAtPriceUzs ?? null,
          stock: input.stock,
          preorderEnabled: input.preorderEnabled,
          preorderLimit: input.preorderLimit,
          preorderReserved: 0,
          preorderEstimatedAt: input.preorderEstimatedAt ?? null,
          categoryId: input.categoryId,
          approvedById: request.user.userId,
          approvedAt: new Date(),
          status: input.publish ? 'PUBLISHED' : 'DRAFT',
          publishedAt: input.publish ? new Date() : null,
          images: {
            create: input.images.map((image, sortOrder) => {
              const file = mediaById.get(image.mediaId!);
              if (!file) throw new Error('Product photo reference was not resolved');
              return { mediaId: file.id, url: file.url, sortOrder, alt: { ru: input.title } };
            }),
          },
          variants: input.colors?.length
            ? { create: input.colors.map((color, index) => ({ sku: `MANUAL-${sourceProductId}-${index + 1}`, color: `${color.name}::${color.hex.toUpperCase()}`, size: input.size, sourcePriceCny: null, salePriceUzs: input.salePriceUzs, stock: input.stock })) }
            : input.color || input.size ? { create: [{ sku: `MANUAL-${sourceProductId}`, color: input.color, size: input.size, sourcePriceCny: null, salePriceUzs: input.salePriceUzs, stock: input.stock }] } : undefined,
        }, include: { images: { orderBy: { sortOrder: 'asc' } }, variants: true } });
        await tx.auditLog.create({ data: { userId: request.user.userId, action: 'PRODUCT_MANUALLY_CREATED', resource: 'CommerceProduct', resourceId: created.id, meta: { published: input.publish } } });
        return created;
        })));
    } catch (error) {
      if (error instanceof ProductPublicIdCollisionError) {
        return reply.status(409).send({ code: error.message, message: 'Не удалось создать уникальный публичный ID товара' });
      }
      throw error;
    }
    return reply.status(201).send(product);
  });

  app.put('/admin/products/:id', { preHandler: adminMiddleware }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = updateManualProductSchema.parse(request.body);
    const product = await app.prisma.commerceProduct.findUnique({
      where: { id },
      select: {
        id: true,
        source: true,
        status: true,
        publishedAt: true,
        categoryId: true,
        preorderEnabled: true,
        preorderLimit: true,
        preorderReserved: true,
        translations: true,
        description: true,
        images: { orderBy: { sortOrder: 'asc' }, select: { id: true, url: true, mediaId: true, sortOrder: true } },
        variants: { select: { id: true, sku: true, stock: true, active: true } },
      },
    });
    if (!product) return reply.status(404).send({ message: 'Товар не найден' });

    let removedMediaIds: string[] = [];
    const updated = await app.prisma.$transaction(async (tx) => {
      const preorderEnabled = input.preorderEnabled ?? product.preorderEnabled;
      const preorderLimit = input.preorderLimit ?? product.preorderLimit;
      if (preorderEnabled && preorderLimit < 1) {
        throw Object.assign(new Error('Enabled preorder requires a positive bounded quantity'), { statusCode: 400 });
      }
      if (preorderLimit < product.preorderReserved) {
        throw Object.assign(new Error('Preorder limit cannot be lower than already reserved quantity'), { statusCode: 409 });
      }
      let resolvedImages: Array<{ id?: string; mediaId: string | null; url: string }> | undefined;
      if (input.images) {
        const settings = await tx.siteSettings.findUnique({
          where: { id: 'singleton' },
          select: { maxProductPhotos: true, maxProductPhotoSizeMb: true },
        });
        const maxPhotos = Math.min(15, settings?.maxProductPhotos ?? 15);
        const maxPhotoBytes = Math.min(25, settings?.maxProductPhotoSizeMb ?? 10) * 1024 * 1024;
        if (input.images.length > maxPhotos) {
          throw Object.assign(new Error(`A product can have at most ${maxPhotos} photos`), { statusCode: 400 });
        }
        const mediaIds = input.images.map((image) => image.mediaId).filter((mediaId): mediaId is string => Boolean(mediaId));
        const mediaFiles = await tx.media.findMany({ where: { id: { in: mediaIds } } });
        if (mediaFiles.length !== mediaIds.length || mediaFiles.some((image) => image.size > maxPhotoBytes)) {
          throw Object.assign(new Error('One or more product photos are missing or exceed the configured file size limit'), { statusCode: 400 });
        }
        const mediaById = new Map(mediaFiles.map((image) => [image.id, image]));
        const existingById = new Map(product.images.map((image) => [image.id, image]));
        resolvedImages = input.images.map((image) => {
          if (image.id) {
            const existing = existingById.get(image.id);
            if (!existing) throw Object.assign(new Error('Product image does not belong to this product'), { statusCode: 400 });
            return { id: existing.id, mediaId: existing.mediaId, url: existing.url };
          }
          const file = mediaById.get(image.mediaId!);
          if (!file) throw Object.assign(new Error('Product photo reference was not resolved'), { statusCode: 400 });
          return { mediaId: file.id, url: file.url };
        });
      }
      if (input.categoryId && input.categoryId !== product.categoryId) {
        const category = await tx.commerceCategory.findUnique({
          where: { id: input.categoryId },
          select: { id: true, active: true },
        });
        if (!category?.active) {
          throw Object.assign(new Error('The selected category is not active'), { statusCode: 400 });
        }
      }
      const manualVariant = product.variants.find((variant) => variant.sku.startsWith('MANUAL-'));
      const hasActiveVariants = product.variants.some((variant) => variant.active);
      if (input.stock !== undefined && hasActiveVariants && (!manualVariant || !manualVariant.active)) {
        throw Object.assign(new Error('Stock for variant products must be managed on the variant'), { statusCode: 400 });
      }
      const descriptionsProvided = input.description !== undefined
        || input.descriptionUz !== undefined
        || input.descriptionEn !== undefined;
      const updatedProduct = await tx.commerceProduct.update({
        where: { id },
        data: {
          ...(input.country !== undefined ? { country: input.country } : {}),
          ...(input.sizeChartType !== undefined ? { sizeChartType: input.sizeChartType } : {}),
          ...(input.title !== undefined || input.titleUz !== undefined || input.titleEn !== undefined
            ? {
                translations: mergeLocalizedTitles(product.translations, {
                  ru: input.title,
                  uz: input.titleUz,
                  en: input.titleEn,
                }),
              }
            : {}),
          ...(descriptionsProvided
            ? {
                description: mergeLocalizedDescriptions(product.description, {
                  ru: input.description,
                  uz: input.descriptionUz,
                  en: input.descriptionEn,
                }),
              }
            : {}),
          ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
          ...(input.salePriceUzs !== undefined ? { salePriceUzs: input.salePriceUzs } : {}),
          ...(input.compareAtPriceUzs !== undefined ? { compareAtPriceUzs: input.compareAtPriceUzs } : {}),
          ...(input.preorderEnabled !== undefined ? { preorderEnabled: input.preorderEnabled } : {}),
          ...(input.preorderLimit !== undefined ? { preorderLimit: input.preorderLimit } : {}),
          ...(input.preorderEstimatedAt !== undefined ? { preorderEstimatedAt: input.preorderEstimatedAt } : {}),
          ...(input.stock !== undefined && !hasActiveVariants && input.color === undefined && input.size === undefined
            ? { stock: input.stock }
            : {}),
          ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
          ...(input.publish !== undefined ? {
            status: input.publish ? ProductPublicationStatus.PUBLISHED
              : product.status === ProductPublicationStatus.ARCHIVED
                ? ProductPublicationStatus.ARCHIVED
                : ProductPublicationStatus.DRAFT,
            publishedAt: input.publish ? (product.publishedAt ?? new Date())
              : product.status === ProductPublicationStatus.ARCHIVED ? product.publishedAt : null,
          } : {}),
        },
      });
      const changedFields = Object.keys(input);
      const countryOnlyUpdate = changedFields.length === 1 && changedFields[0] === 'country';
      await tx.auditLog.create({
        data: {
          userId: request.user.userId,
          action: countryOnlyUpdate ? 'PRODUCT_COUNTRY_UPDATED' : 'PRODUCT_UPDATED',
          resource: 'CommerceProduct',
          resourceId: id,
          meta: { changedFields, ...(input.country !== undefined ? { country: input.country } : {}) },
        },
      });

      if (resolvedImages) {
        const retainedIds = resolvedImages.flatMap((image) => image.id ? [image.id] : []);
        removedMediaIds = product.images
          .filter((image) => !retainedIds.includes(image.id) && image.mediaId)
          .map((image) => image.mediaId!);
        await tx.commerceProductImage.deleteMany({
          where: { productId: id, ...(retainedIds.length ? { id: { notIn: retainedIds } } : {}) },
        });
        for (const [sortOrder, image] of resolvedImages.entries()) {
          if (image.id) {
            await tx.commerceProductImage.update({
              where: { id: image.id },
              data: { sortOrder },
            });
          } else {
            await tx.commerceProductImage.create({
              data: { productId: id, mediaId: image.mediaId, url: image.url, sortOrder },
            });
          }
        }
      }

      if (product.source === 'MANUAL' && (
        input.color !== undefined || input.colors !== undefined || input.size !== undefined || input.salePriceUzs !== undefined || input.stock !== undefined
      )) {
        if (input.colors !== undefined) {
          await tx.commerceProductVariant.updateMany({ where: { productId: id }, data: { active: false } });
          for (const [index, colorOption] of input.colors.entries()) {
            await tx.commerceProductVariant.create({ data: {
              productId: id,
              sku: `MANUAL-${randomUUID()}-${index + 1}`,
              color: `${colorOption.name}::${colorOption.hex.toUpperCase()}`,
              size: input.size?.trim() || null,
              sourcePriceCny: null,
              salePriceUzs: input.salePriceUzs ?? Number(updatedProduct.salePriceUzs),
              stock: input.stock ?? 0,
            } });
          }
        } else {
        const color = input.color?.trim() || null;
        const size = input.size?.trim() || null;
        const variant = manualVariant;
        const changedVariantOptions = input.color !== undefined || input.size !== undefined || input.salePriceUzs !== undefined;
        if (variant && !changedVariantOptions && input.stock !== undefined) {
          await tx.commerceProductVariant.update({
            where: { id: variant.id },
            data: { stock: input.stock },
          });
        } else if (variant && (color || size)) {
          await tx.commerceProductVariant.update({
            where: { id: variant.id },
            data: {
              color,
              size,
              active: true,
              ...(input.stock !== undefined ? { stock: input.stock } : {}),
              ...(input.salePriceUzs !== undefined ? { salePriceUzs: input.salePriceUzs } : {}),
            },
          });
        } else if (variant) {
          await tx.commerceProductVariant.update({
            where: { id: variant.id },
            data: { active: false },
          });
        } else if (color || size) {
          await tx.commerceProductVariant.create({
            data: {
              productId: id,
              sku: `MANUAL-${randomUUID()}`,
              color,
              size,
              sourcePriceCny: null,
              salePriceUzs: input.salePriceUzs ?? Number(updatedProduct.salePriceUzs),
              stock: input.stock ?? 0,
            },
          });
        }
        }
      }
      return updatedProduct;
    });
    if (removedMediaIds.length) {
      const mediaToDelete = await app.prisma.media.findMany({
        where: { id: { in: removedMediaIds }, listingId: null, productImages: { none: {} } },
        select: { id: true },
      });
      const { MediaService } = await import('../media/service');
      const mediaService = new MediaService(app.prisma, undefined, request.log);
      for (const media of mediaToDelete) {
        await mediaService.delete(media.id, request.user.userId, true).catch((error) => {
          request.log.error({ err: error, mediaId: media.id, productId: id }, 'Failed to clean up removed product photo');
        });
      }
    }
    return updated;
  });

  app.post('/admin/products/:id/archive', { preHandler: adminMiddleware }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const product = await app.prisma.commerceProduct.findUnique({ where: { id }, select: { id: true } });
    if (!product) return reply.status(404).send({ message: 'Product not found' });
    const archived = await app.prisma.$transaction(async (tx) => {
      const result = await tx.commerceProduct.update({ where: { id }, data: { status: ProductPublicationStatus.ARCHIVED } });
      await tx.auditLog.create({ data: { userId: request.user.userId, action: 'PRODUCT_ARCHIVED', resource: 'CommerceProduct', resourceId: id } });
      return result;
    });
    return archived;
  });

  app.post('/admin/products/:id/restore', { preHandler: adminMiddleware }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const product = await app.prisma.commerceProduct.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!product) return reply.status(404).send({ message: 'Product not found' });
    const restored = await app.prisma.$transaction(async (tx) => {
      const result = await tx.commerceProduct.update({ where: { id }, data: { status: ProductPublicationStatus.DRAFT, publishedAt: null } });
      await tx.auditLog.create({ data: { userId: request.user.userId, action: 'PRODUCT_RESTORED', resource: 'CommerceProduct', resourceId: id } });
      return result;
    });
    return restored;
  });

  app.delete('/admin/products/:id', { preHandler: adminMiddleware }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const product = await app.prisma.commerceProduct.findUnique({ where: { id }, select: { id: true, images: { select: { mediaId: true } } } });
    if (!product) return reply.status(404).send({ message: 'Product not found' });
    try {
      await app.prisma.$transaction(async (tx) => {
        await tx.auditLog.create({ data: { userId: request.user.userId, action: 'PRODUCT_PERMANENTLY_DELETED', resource: 'CommerceProduct', resourceId: id } });
        await tx.commerceProduct.delete({ where: { id } });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        return reply.status(409).send({ message: 'Product is used in an order and cannot be permanently deleted. Archive it instead.' });
      }
      throw error;
    }
    if (product.images.length) {
      const mediaToDelete = await app.prisma.media.findMany({
        where: { id: { in: product.images.map((image) => image.mediaId).filter((mediaId): mediaId is string => Boolean(mediaId)) }, listingId: null, productImages: { none: {} } },
        select: { id: true },
      });
      const { MediaService } = await import('../media/service');
      const mediaService = new MediaService(app.prisma, undefined, request.log);
      await Promise.allSettled(mediaToDelete.map((media) => mediaService.delete(media.id, request.user.userId, true)));
    }
    return reply.status(204).send();
  });

  app.post('/admin/imports', { preHandler: adminMiddleware }, async (request, reply) => {
    const input = createImportSchema.parse(request.body);
    if (input.source === 'SOURCE_1688' && !featureFlags.isEnabled('PARSER_1688')) {
      return reply.status(403).send({ code: 'FEATURE_DISABLED', message: 'The 1688 parser is disabled.' });
    }
    const {
      sourceProvider,
      sourceMetadata,
      deduplicationKey,
      ...importData
    } = input;
    const persistedSourceMetadata = {
      ...(sourceMetadata ?? {}),
      sourceProvider: sourceProvider ?? input.source,
      deduplicationKey: deduplicationKey ?? `${input.source}:${input.sourceProductId}`,
    };
    const where = { source_sourceProductId: { source: input.source, sourceProductId: input.sourceProductId } };
    const existing = await app.prisma.importedProduct.findUnique({ where });
    if (existing && existing.status !== 'PENDING_REVIEW') {
      return reply.send({ result: 'ALREADY_EXISTS', item: existing });
    }
    const createData = {
      ...importData,
      sourceMetadata: persistedSourceMetadata,
      status: 'PENDING_REVIEW',
      normalizedPayload: importData.normalizedPayload as Prisma.InputJsonValue,
      aiPayload: importData.aiPayload as Prisma.InputJsonValue | undefined,
      aiWarnings: importData.aiWarnings as Prisma.InputJsonValue | undefined,
    } satisfies Prisma.ImportedProductUncheckedCreateInput;
    if (existing) {
      const changed = await app.prisma.importedProduct.updateMany({
        where: { source: input.source, sourceProductId: input.sourceProductId, status: 'PENDING_REVIEW' },
        data: {
          sourceUrl: input.sourceUrl,
          originalTitle: input.originalTitle,
          sourceMetadata: persistedSourceMetadata,
          sourcePriceCny: input.sourcePriceCny,
          normalizedPayload: importData.normalizedPayload as Prisma.InputJsonValue,
          aiPayload: importData.aiPayload as Prisma.InputJsonValue | undefined,
          aiWarnings: importData.aiWarnings as Prisma.InputJsonValue | undefined,
        },
      });
      if (changed.count !== 1) {
        const latest = await app.prisma.importedProduct.findUnique({ where });
        if (latest) return reply.send({ result: 'ALREADY_EXISTS', item: latest });
        throw new Error('IMPORT_UPDATE_RACE');
      }
      const item = await app.prisma.importedProduct.findUniqueOrThrow({ where });
      return reply.status(200).send({ result: 'UPDATED_PENDING', item });
    }
    try {
      const item = await app.prisma.importedProduct.create({ data: createData });
      dispatchDomainEvent(app, {
        type: 'product.import.received',
        importId: item.id,
        provider: persistedSourceMetadata.sourceProvider,
        occurredAt: new Date().toISOString(),
      });
      return reply.status(201).send({ result: 'CREATED', item });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const raced = await app.prisma.importedProduct.findUnique({ where });
      if (!raced) throw error;
      return reply.send({ result: 'ALREADY_EXISTS', item: raced });
    }
  });

  app.post('/admin/imports/:id/approve', { preHandler: adminMiddleware }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = approveImportSchema.parse(request.body);
    const imported = await app.prisma.importedProduct.findUnique({ where: { id } });
    if (!imported) return reply.status(404).send({ message: 'Импорт не найден' });
    assertHumanApproval(imported.status, request.user.userId);
    const title = localizedTitle(input.translations ?? imported.aiPayload, imported.originalTitle);
    const media = input.mediaIds.length
      ? await app.prisma.media.findMany({ where: { id: { in: input.mediaIds } } })
      : [];
    if (media.length !== input.mediaIds.length) {
      return reply.status(400).send({ code: 'INVALID_MEDIA', message: 'One or more uploaded product images are unavailable.' });
    }
    if (input.publish && media.length === 0) {
      return reply.status(400).send({ code: 'PRODUCT_IMAGE_REQUIRED', message: 'Upload at least one AVERON product image before publication.' });
    }
    const settings = await app.prisma.siteSettings.findUnique({
      where: { id: 'singleton' },
      select: { maxProductPhotos: true, maxProductPhotoSizeMb: true },
    });
    const maxPhotos = Math.min(15, settings?.maxProductPhotos ?? 15);
    const maxPhotoBytes = Math.min(25, settings?.maxProductPhotoSizeMb ?? 10) * 1024 * 1024;
    if (media.length > maxPhotos || media.some((image) => image.size > maxPhotoBytes)) {
      return reply.status(400).send({ code: 'PRODUCT_MEDIA_LIMIT', message: 'One or more uploaded product images exceed the configured limits.' });
    }
    const mediaById = new Map(media.map((image) => [image.id, image]));
    let result;
    try {
      result = await createProductWithUniquePublicId(title, (publicId, slug) => app.prisma.$transaction(async (tx) => {
        const claimed = await tx.importedProduct.updateMany({
          where: { id, status: 'PENDING_REVIEW' },
          data: { status: 'APPROVED', reviewedById: request.user.userId, reviewedAt: new Date() },
        });
        if (claimed.count !== 1) throw new Error('IMPORT_NOT_PENDING_REVIEW');
        const product = await tx.commerceProduct.create({ data: {
          slug,
          publicId,
          country: input.country,
          sizeChartType: input.sizeChartType ?? null,
          translations: (input.translations ?? imported.aiPayload ?? { ru: { title } }) as Prisma.InputJsonValue,
          description: input.translations
            ? Object.fromEntries(Object.entries(input.translations).flatMap(([locale, content]) =>
              content?.description ? [[locale, content.description]] : [])) as Prisma.InputJsonValue
            : undefined,
          source: imported.source, sourceProductId: imported.sourceProductId, sourceUrl: imported.sourceUrl,
          originalPriceCny: imported.sourcePriceCny, exchangeRate: input.exchangeRate ?? null, salePriceUzs: input.salePriceUzs,
          categoryId: imported.categoryId, importedFromId: imported.id, approvedById: request.user.userId,
          approvedAt: new Date(), status: input.publish ? 'PUBLISHED' : 'DRAFT', publishedAt: input.publish ? new Date() : null,
          images: input.mediaIds.length ? { create: input.mediaIds.map((mediaId, sortOrder) => {
            const file = mediaById.get(mediaId);
            if (!file) throw new Error('Product media reference was not resolved');
            return { mediaId: file.id, url: file.url, sortOrder, alt: { ru: title } };
          }) } : undefined,
        }, include: { images: { orderBy: { sortOrder: 'asc' } } } });
        await tx.auditLog.create({ data: { userId: request.user.userId, action: 'PRODUCT_IMPORT_APPROVED', resource: 'ImportedProduct', resourceId: id, meta: { productId: product.id, published: input.publish } } });
        return product;
      }));
    } catch (error) {
      if (error instanceof Error && error.message === 'IMPORT_NOT_PENDING_REVIEW') {
        return reply.status(409).send({ code: error.message, message: 'This import is no longer awaiting review.' });
      }
      if (error instanceof ProductPublicIdCollisionError) {
        return reply.status(409).send({ code: error.message, message: 'Не удалось создать уникальный публичный ID товара' });
      }
      throw error;
    }
    const occurredAt = new Date().toISOString();
    dispatchDomainEvent(app, {
      type: 'product.import.approved',
      importId: id,
      productId: result.id,
      actorId: request.user.userId,
      occurredAt,
    });
    if (input.publish) {
      dispatchDomainEvent(app, {
        type: 'product.published',
        productId: result.id,
        actorId: request.user.userId,
        occurredAt,
      });
    }
    return result;
  });

  app.post('/admin/imports/:id/reject', { preHandler: adminMiddleware }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = rejectImportSchema.parse(request.body);
    const imported = await app.prisma.importedProduct.findUnique({ where: { id } });
    if (!imported) return reply.status(404).send({ message: 'Импорт не найден' });
    assertHumanApproval(imported.status, request.user.userId);
    try {
      const item = await app.prisma.$transaction(async (tx) => {
        const claimed = await tx.importedProduct.updateMany({
          where: { id, status: 'PENDING_REVIEW' },
          data: { status: 'REJECTED', rejectionReason: input.reason, reviewedById: request.user.userId, reviewedAt: new Date() },
        });
        if (claimed.count !== 1) throw new Error('IMPORT_NOT_PENDING_REVIEW');
        const updated = await tx.importedProduct.findUniqueOrThrow({ where: { id } });
        await tx.auditLog.create({ data: { userId: request.user.userId, action: 'PRODUCT_IMPORT_REJECTED', resource: 'ImportedProduct', resourceId: id, meta: { reason: input.reason } } });
        return updated;
      });
      dispatchDomainEvent(app, {
        type: 'product.import.rejected',
        importId: id,
        actorId: request.user.userId,
        reason: input.reason,
        occurredAt: new Date().toISOString(),
      });
      return item;
    } catch (error) {
      if (error instanceof Error && error.message === 'IMPORT_NOT_PENDING_REVIEW') {
        return reply.status(409).send({ code: error.message });
      }
      throw error;
    }
  });

};
