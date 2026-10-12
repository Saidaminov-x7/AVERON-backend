import { Prisma, PrismaClient } from '@prisma/client';
import type {
  EmbeddingFingerprintKey,
  ImageEmbeddingDescriptor,
  ProductImageForEmbedding,
  ProductImageSource,
  SimilarProductSeed,
  StoredProductEmbedding,
  VectorSearchRepository,
  VisualSearchCandidate,
  VisualSearchFilters,
} from './contracts';
import type { IStorageAdapter } from '../media/storage';

const VECTOR_DIMENSIONS = 1024;
const SEARCH_CANDIDATE_LIMIT = 100;

function parseVector(raw: string | null | undefined): number[] | null {
  if (!raw || raw.length < 3 || raw[0] !== '[' || raw[raw.length - 1] !== ']') return null;
  const values = raw.slice(1, -1).split(',').map(Number);
  if (values.length !== VECTOR_DIMENSIONS || values.some((value) => !Number.isFinite(value))) return null;
  return values;
}

function asStoredEmbedding(row: {
  productId: string;
  productImageId: string;
  provider: string;
  model: string;
  dimensions: number;
  embeddingVersion: string;
  imageFingerprint: string;
  vector: string | null;
}): StoredProductEmbedding | null {
  const embedding = parseVector(row.vector);
  if (!embedding) return null;
  return {
    productId: row.productId,
    productImageId: row.productImageId,
    provider: row.provider,
    model: row.model,
    dimensions: row.dimensions,
    embeddingVersion: row.embeddingVersion,
    imageFingerprint: row.imageFingerprint,
    embedding,
  };
}

export class PrismaVectorSearchRepository implements VectorSearchRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly enabled: boolean,
  ) {}

  isAvailable(): boolean {
    return this.enabled;
  }

  async hasIndexedFingerprint(key: EmbeddingFingerprintKey): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1 FROM "ProductImageEmbedding"
        WHERE "productImageId" = ${key.productImageId}
          AND "provider" = ${key.provider}
          AND "model" = ${key.model}
          AND "dimensions" = ${key.dimensions}
          AND "embeddingVersion" = ${key.embeddingVersion}
          AND "imageFingerprint" = ${key.imageFingerprint}
          AND "status" = 'INDEXED'
          AND "embeddingVector" IS NOT NULL
      ) AS present
    `);
    return rows[0]?.present === true;
  }

  async storeEmbedding(
    key: EmbeddingFingerprintKey & { productId: string; embedding: readonly number[] },
  ): Promise<void> {
    if (key.dimensions !== VECTOR_DIMENSIONS || key.embedding.length !== VECTOR_DIMENSIONS) {
      throw new Error('VISUAL_SEARCH_VECTOR_DIMENSIONS_INVALID');
    }
    const float32 = new Float32Array(key.embedding);
    const embeddingBytes = Buffer.from(float32.buffer, float32.byteOffset, float32.byteLength);
    const vectorLiteral = JSON.stringify(Array.from(key.embedding));

    await this.prisma.$transaction(async (transaction) => {
      const row = await transaction.productImageEmbedding.upsert({
        where: {
          productImageId_provider_model_embeddingVersion_imageFingerprint: {
            productImageId: key.productImageId,
            provider: key.provider,
            model: key.model,
            embeddingVersion: key.embeddingVersion,
            imageFingerprint: key.imageFingerprint,
          },
        },
        update: {
          productId: key.productId,
          dimensions: key.dimensions,
          embeddingBytes,
          status: 'PENDING',
          failureCode: null,
          indexedAt: null,
        },
        create: {
          productId: key.productId,
          productImageId: key.productImageId,
          provider: key.provider,
          model: key.model,
          dimensions: key.dimensions,
          embeddingVersion: key.embeddingVersion,
          imageFingerprint: key.imageFingerprint,
          embeddingBytes,
          status: 'PENDING',
        },
        select: { id: true },
      });

      await transaction.$executeRaw(Prisma.sql`
        UPDATE "ProductImageEmbedding"
        SET "embeddingVector" = ${vectorLiteral}::vector,
            "status" = 'INDEXED',
            "failureCode" = NULL,
            "indexedAt" = CURRENT_TIMESTAMP,
            "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${row.id}
      `);
    });
  }

  async searchCandidates(
    query: readonly number[],
    descriptor: ImageEmbeddingDescriptor,
    filters: VisualSearchFilters & { excludeProductId?: string; preferredCategoryId?: string },
  ): Promise<VisualSearchCandidate[]> {
    if (query.length !== VECTOR_DIMENSIONS) throw new Error('VISUAL_SEARCH_VECTOR_DIMENSIONS_INVALID');
    const vectorLiteral = JSON.stringify(Array.from(query));
    const predicates: Prisma.Sql[] = [
      Prisma.sql`e."provider" = ${descriptor.provider}`,
      Prisma.sql`e."model" = ${descriptor.model}`,
      Prisma.sql`e."dimensions" = ${descriptor.dimensions}`,
      Prisma.sql`e."embeddingVersion" = ${descriptor.embeddingVersion}`,
      Prisma.sql`e."status" = 'INDEXED'`,
      Prisma.sql`e."embeddingVector" IS NOT NULL`,
      Prisma.sql`p."status" = 'PUBLISHED'`,
      Prisma.sql`(p."categoryId" IS NULL OR c."active" = TRUE)`,
    ];
    if (filters.country) predicates.push(Prisma.sql`p."country"::text = ${filters.country}`);
    if (filters.categorySlug) predicates.push(Prisma.sql`c."slug" = ${filters.categorySlug}`);
    if (filters.excludeProductId) predicates.push(Prisma.sql`p."id" <> ${filters.excludeProductId}`);

    const rows = await this.prisma.$queryRaw<Array<{
      productId: string;
      productImageId: string;
      provider: string;
      model: string;
      dimensions: number;
      embeddingVersion: string;
      imageFingerprint: string;
      vector: string | null;
      similarity: number;
    }>>(Prisma.sql`
      SELECT e."productId", e."productImageId", e."provider", e."model", e."dimensions",
             e."embeddingVersion", e."imageFingerprint", e."embeddingVector"::text AS vector,
             (1 - (e."embeddingVector" <=> ${vectorLiteral}::vector))::float8 AS similarity
      FROM "ProductImageEmbedding" e
      JOIN "CommerceProduct" p ON p."id" = e."productId"
      LEFT JOIN "CommerceCategory" c ON c."id" = p."categoryId"
      WHERE ${Prisma.join(predicates, ' AND ')}
      ORDER BY e."embeddingVector" <=> ${vectorLiteral}::vector
      LIMIT ${SEARCH_CANDIDATE_LIMIT}
    `);
    if (!rows.length) return [];

    const productIds = [...new Set(rows.map((row) => row.productId))];
    const products = await this.prisma.commerceProduct.findMany({
      where: {
        id: { in: productIds },
        status: 'PUBLISHED',
        OR: [{ categoryId: null }, { category: { is: { active: true } } }],
      },
      select: {
        id: true,
        slug: true,
        country: true,
        categoryId: true,
        translations: true,
        salePriceUzs: true,
        compareAtPriceUzs: true,
        images: {
          orderBy: { sortOrder: 'asc' },
          take: 3,
          select: { id: true, url: true, alt: true },
        },
      },
    });
    const productById = new Map(products.map((product) => [product.id, product]));
    const seenProducts = new Set<string>();
    return rows.flatMap((row) => {
      if (seenProducts.has(row.productId)) return [];
      const product = productById.get(row.productId);
      const embedding = asStoredEmbedding(row);
      if (!product || !embedding || !Number.isFinite(row.similarity)) return [];
      seenProducts.add(row.productId);
      return [{
        ...embedding,
        similarity: row.similarity,
        status: 'PUBLISHED',
        product: {
          ...product,
          country: String(product.country),
          salePriceUzs: product.salePriceUzs.toString(),
          compareAtPriceUzs: product.compareAtPriceUzs?.toString() ?? null,
          images: product.images.map((image) => ({ id: image.id, url: image.url, alt: image.alt ?? undefined })),
        },
      }];
    }).slice(0, filters.limit);
  }

  async getPublishedProductSeed(
    identifier: string,
    descriptor: ImageEmbeddingDescriptor,
  ): Promise<SimilarProductSeed | null> {
    const product = await this.prisma.commerceProduct.findFirst({
      where: {
        OR: [{ slug: identifier }, { publicId: identifier }],
        status: 'PUBLISHED',
        AND: [{ OR: [{ categoryId: null }, { category: { is: { active: true } } }] }],
      },
      select: { id: true, country: true, categoryId: true },
    });
    if (!product) return null;

    const rows = await this.prisma.$queryRaw<Array<{
      productId: string;
      productImageId: string;
      provider: string;
      model: string;
      dimensions: number;
      embeddingVersion: string;
      imageFingerprint: string;
      vector: string | null;
    }>>(Prisma.sql`
      SELECT "productId", "productImageId", "provider", "model", "dimensions",
             "embeddingVersion", "imageFingerprint", "embeddingVector"::text AS vector
      FROM "ProductImageEmbedding"
      WHERE "productId" = ${product.id}
        AND "provider" = ${descriptor.provider}
        AND "model" = ${descriptor.model}
        AND "dimensions" = ${descriptor.dimensions}
        AND "embeddingVersion" = ${descriptor.embeddingVersion}
        AND "status" = 'INDEXED'
        AND "embeddingVector" IS NOT NULL
      ORDER BY "indexedAt" DESC NULLS LAST
      LIMIT 1
    `);
    return {
      id: product.id,
      country: String(product.country),
      categoryId: product.categoryId,
      embedding: rows[0] ? asStoredEmbedding(rows[0]) : null,
    };
  }

  async getProductImageEmbeddingStatus(productId: string) {
    const row = await this.prisma.productImageEmbedding.findFirst({
      where: { productId },
      orderBy: { updatedAt: 'desc' },
      select: {
        status: true,
        provider: true,
        model: true,
        embeddingVersion: true,
        indexedAt: true,
      },
    });
    if (!row) return null;
    return {
      status: row.status as 'PENDING' | 'INDEXED' | 'FAILED',
      provider: row.provider,
      model: row.model,
      embeddingVersion: row.embeddingVersion,
      indexedAt: row.indexedAt,
    };
  }
}

export class PrismaProductImageSource implements ProductImageSource {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storage: IStorageAdapter,
  ) {}

  isAvailable(): boolean {
    return true;
  }

  async getMainProductImage(productId: string): Promise<ProductImageForEmbedding | null> {
    const row = await this.prisma.commerceProductImage.findFirst({
      where: {
        productId,
        mediaId: { not: null },
        product: {
          status: 'PUBLISHED',
          OR: [{ categoryId: null }, { category: { is: { active: true } } }],
        },
      },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        media: { select: { url: true, mimeType: true, size: true } },
      },
    });
    if (!row?.media || row.media.size <= 0 || row.media.size > 10 * 1024 * 1024) return null;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(row.media.mimeType)) return null;
    const data = await this.storage.read(row.media.url);
    if (data.length === 0 || data.length > 10 * 1024 * 1024) return null;
    return { id: row.id, mimeType: row.media.mimeType, data };
  }
}
