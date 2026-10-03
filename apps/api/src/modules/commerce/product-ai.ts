import type { FastifyPluginAsync } from 'fastify';
import { adminMiddleware } from '../../lib/adminMiddleware';
import { featureFlags } from '../features/feature-flags';
import { productAiInputSchema, productAiRequestSchema } from './product-ai.schemas';
import { productAiProvider } from './product-ai-provider';
import { MediaService } from '../media/service';

export const productAiModule: FastifyPluginAsync = async (app) => {
  app.post('/admin/products/ai-suggestions', {
    preHandler: adminMiddleware,
    config: { rateLimit: { max: 5, timeWindow: '1 minute', skipOnError: false } },
  }, async (request, reply) => {
    if (!featureFlags.isEnabled('AI_PRODUCT_FILL')) {
      return reply.status(403).send({ code: 'FEATURE_DISABLED', message: 'AI product suggestions are disabled.' });
    }
    if (!productAiProvider.isConfigured()) {
      return reply.status(503).send({ code: 'AI_PROVIDER_NOT_CONFIGURED', message: 'AI suggestions are not configured.' });
    }

    const parsed = productAiRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ code: 'AI_PRODUCT_INPUT_INVALID' });
    try {
      const mediaService = new MediaService(app.prisma, undefined, request.log);
      const images = await mediaService.readVerifiedImages(parsed.data.mediaIds);
      const { mediaIds: _mediaIds, ...textInput } = parsed.data;
      const categories = await app.prisma.commerceCategory.findMany({
        where: { active: true },
        select: { id: true, slug: true, name: true },
        orderBy: [{ sortOrder: 'asc' }, { slug: 'asc' }],
        take: 200,
      });
      const categoryCandidates = categories.map((category) => ({
        id: category.id,
        slug: category.slug,
        names: Object.fromEntries(
          (['ru', 'uz', 'en'] as const).map((locale) => {
            const name = category.name && typeof category.name === 'object' && !Array.isArray(category.name)
              ? (category.name as Record<string, unknown>)[locale]
              : undefined;
            return [locale, typeof name === 'string' ? name : category.slug];
          }),
        ),
      }));
      const input = productAiInputSchema.parse({ ...textInput, categoryCandidates, images });
      const suggestion = await productAiProvider.generateProductContent(input);
      const categorySuggestion = suggestion.suggestedCategory;
      const matchedCategory = categorySuggestion && categorySuggestion.confidence >= 0.8
        ? categories.find((category) => category.slug === categorySuggestion.slug)
        : undefined;
      const { suggestedCategory: _suggestedCategory, ...suggestions } = suggestion;
      return reply.send({
        suggestions,
        suggestedCategory: matchedCategory
          ? {
            id: matchedCategory.id,
            slug: matchedCategory.slug,
            name: categoryCandidates.find((category) => category.id === matchedCategory.id)?.names,
          }
          : null,
      });
    } catch (error) {
      if (error instanceof Error && 'statusCode' in error) {
        const statusCode = (error as Error & { statusCode: number }).statusCode;
        if (statusCode >= 400 && statusCode < 500) {
          return reply.status(statusCode).send({ code: 'AI_PRODUCT_MEDIA_INVALID' });
        }
      }
      const providerStatus = error instanceof Error && /^AI_PROVIDER_HTTP_\d{3}$/.test(error.message)
        ? error.message
        : 'AI_PROVIDER_FAILED';
      request.log.error({ providerErrorCode: providerStatus }, 'AI product suggestion request failed');
      return reply.status(502).send({ code: 'AI_PROVIDER_FAILED', message: 'AI suggestions could not be generated.' });
    }
  });
};
