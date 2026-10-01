import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '@prisma/client';
import type { ProductCountry, ProductSource } from '@prisma/client';
import { ZodError } from 'zod';
import { config } from '../../config';
import { featureFlags } from '../features/feature-flags';
import { dispatchDomainEvent } from '../integrations/domain-events';
import { parserImportProductV1Schema } from './schemas';

const sourceByProvider: Partial<Record<'SOURCE_1688' | 'PINDUODUO', ProductSource>> = {
  SOURCE_1688: 'SOURCE_1688',
};

interface ParserImportDependencies {
  getToken: () => string | undefined;
  isProviderEnabled: (provider: 'SOURCE_1688' | 'PINDUODUO') => boolean;
}

function tokenMatches(supplied: string | undefined, expected: string | undefined): boolean {
  if (!supplied || !expected) return false;
  const suppliedDigest = createHash('sha256').update(supplied).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

export function createParserImportModule(dependencies: ParserImportDependencies): FastifyPluginAsync {
  return async (app) => {
    app.post('/parser/imports', {
      bodyLimit: 256 * 1024,
      config: { rateLimit: { max: 120, timeWindow: '1 minute', skipOnError: false } },
    }, async (request, reply) => {
      const token = dependencies.getToken();
      if (!token) {
        return reply.status(503).send({ code: 'PARSER_IMPORT_NOT_CONFIGURED', message: 'Parser import is not configured.' });
      }
      const authorization = request.headers.authorization;
      const suppliedToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
      if (!tokenMatches(suppliedToken, token)) {
        return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Parser authentication failed.' });
      }

      const body = request.body;
      const schemaVersion = typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).schemaVersion
        : undefined;
      if (typeof schemaVersion === 'number' && schemaVersion !== 1) {
        return reply.status(422).send({
          code: 'UNSUPPORTED_SCHEMA_VERSION',
          supportedVersions: [1],
          message: 'The parser import schema version is not supported.',
        });
      }

      let input: ReturnType<typeof parserImportProductV1Schema.parse>;
      try {
        input = parserImportProductV1Schema.parse(body);
      } catch (error) {
        if (!(error instanceof ZodError)) throw error;
        return reply.status(400).send({
          code: 'INVALID_IMPORT_PAYLOAD',
          message: 'The parser import payload is invalid.',
          issues: error.issues.map(({ path, message }) => ({ path, message })),
        });
      }
      if (!dependencies.isProviderEnabled(input.provider)) {
        return reply.status(403).send({ code: 'FEATURE_DISABLED', message: 'This parser provider is disabled.' });
      }
      const source = sourceByProvider[input.provider];
      if (!source) {
        return reply.status(503).send({ code: 'PROVIDER_UNAVAILABLE', message: 'This parser provider is not available.' });
      }

      const payloadHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const normalizedPayload = {
        schemaVersion: input.schemaVersion,
        provider: input.provider,
        sourceDescription: input.sourceDescription ?? null,
        sourceImages: input.sourceImages,
        sourcePriceCurrency: input.sourcePrice?.currency ?? null,
        sourceCategory: input.sourceCategory ?? null,
        country: input.country satisfies ProductCountry,
        sourceAttributes: input.sourceAttributes,
        variants: input.variants,
        sizes: input.sizes,
        fetchedAt: input.fetchedAt,
        rawMetadata: input.rawMetadata ?? {},
      };
      const sourceMetadata = {
        provider: input.provider,
        deduplicationKey: input.deduplicationKey,
        payloadHash,
      };
      const unique = { source_sourceProductId: { source, sourceProductId: input.sourceProductId } };
      const existing = await app.prisma.importedProduct.findUnique({ where: unique });
      if (existing) {
        if (existing.status !== 'PENDING_REVIEW') {
          return reply.send({ result: 'ALREADY_EXISTS', item: existing });
        }
        const existingMetadata = existing.sourceMetadata as Record<string, unknown> | null;
        if (existingMetadata?.payloadHash === payloadHash) {
          return reply.send({ result: 'UNCHANGED', item: existing });
        }
        const changed = await app.prisma.importedProduct.updateMany({
          where: { id: existing.id, status: 'PENDING_REVIEW' },
          data: {
            sourceUrl: input.sourceUrl,
            originalTitle: input.sourceTitle,
            sourcePriceCny: input.sourcePrice?.amount ?? null,
            sourceMetadata,
            normalizedPayload: normalizedPayload as Prisma.InputJsonValue,
          },
        });
        if (changed.count !== 1) {
          const latest = await app.prisma.importedProduct.findUnique({ where: unique });
          if (latest) return reply.send({ result: 'ALREADY_EXISTS', item: latest });
          throw new Error('IMPORT_UPDATE_RACE');
        }
        const item = await app.prisma.importedProduct.findUniqueOrThrow({ where: { id: existing.id } });
        return reply.send({ result: 'UPDATED_PENDING', item });
      }

      try {
        const item = await app.prisma.importedProduct.create({
          data: {
            source,
            sourceProductId: input.sourceProductId,
            sourceUrl: input.sourceUrl,
            originalTitle: input.sourceTitle,
            sourcePriceCny: input.sourcePrice?.amount ?? null,
            sourceMetadata,
            normalizedPayload: normalizedPayload as Prisma.InputJsonValue,
            status: 'PENDING_REVIEW',
          },
        });
        dispatchDomainEvent(app, {
          type: 'product.import.received',
          importId: item.id,
          provider: input.provider,
          occurredAt: new Date().toISOString(),
        });
        return reply.status(201).send({ result: 'CREATED', item });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
        const racedItem = await app.prisma.importedProduct.findUnique({ where: unique });
        if (!racedItem) throw error;
        return reply.send({ result: 'ALREADY_EXISTS', item: racedItem });
      }
    });
  };
}

export const parserImportModule = createParserImportModule({
  getToken: () => config.PARSER_IMPORT_TOKEN,
  isProviderEnabled: (provider) => featureFlags.isEnabled(provider === 'SOURCE_1688' ? 'PARSER_1688' : 'PARSER_PINDUODUO'),
});
