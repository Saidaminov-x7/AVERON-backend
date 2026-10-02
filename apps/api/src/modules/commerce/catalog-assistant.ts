import type { FastifyPluginAsync } from 'fastify';
import { Prisma, ProductPublicationStatus } from '@prisma/client';
import { z } from 'zod';
import { config } from '../../config';
import { featureFlags } from '../features/feature-flags';
import { catalogAiService, CatalogAiError, type CatalogAiService } from './catalog-ai-service';
import {
  searchIntentSchema,
  searchRequestSchema,
  styleIntentSchema,
  styleRequestSchema,
  catalogColorTerms,
  normalizeCatalogColor,
  type SearchIntent,
  type SearchOverrides,
  type StyleIntent,
} from './catalog-assistant-schemas';
import { publicProductDto } from './public-product-dto';

const productInclude = {
  images: { orderBy: { sortOrder: 'asc' as const }, take: 3 },
  variants: { where: { active: true } },
  category: true,
} satisfies Prisma.CommerceProductInclude;

type CatalogProduct = Prisma.CommerceProductGetPayload<{ include: typeof productInclude }>;
type OutfitRole = NonNullable<StyleIntent['requiredCategories']>[number];

const rateLimit = {
  max: config.AI_REQUEST_RATE_LIMIT_MAX,
  timeWindow: `${config.AI_REQUEST_RATE_LIMIT_WINDOW_SEC} seconds`,
  skipOnError: false,
};

function mergeOverrides(intent: SearchIntent, overrides?: SearchOverrides): SearchIntent {
  if (!overrides) return intent;
  const merged = { ...intent };
  for (const key of ['category', 'gender', 'minPrice', 'maxPrice'] as const) {
    const value = overrides[key];
    if (value === null) delete merged[key];
    else if (value !== undefined) Object.assign(merged, { [key]: value });
  }
  if (overrides.colors !== undefined) {
    merged.colors = overrides.colors.map(normalizeCatalogColor);
  }
  if (overrides.sizes !== undefined) merged.sizes = overrides.sizes;
  return searchIntentSchema.parse(merged);
}

function buildSearchWhere(intent: SearchIntent): Prisma.CommerceProductWhereInput {
  const where: Prisma.CommerceProductWhereInput = {
    status: ProductPublicationStatus.PUBLISHED,
    ...(intent.category ? { category: { slug: intent.category, active: true } } : {}),
    ...(intent.gender ? { attributes: { path: ['audience'], equals: intent.gender } } : {}),
    ...(intent.minPrice !== undefined || intent.maxPrice !== undefined
      ? { salePriceUzs: {
          ...(intent.minPrice !== undefined ? { gte: intent.minPrice } : {}),
          ...(intent.maxPrice !== undefined ? { lte: intent.maxPrice } : {}),
        } }
      : {}),
  };

  if (intent.colors?.length || intent.sizes?.length) {
    where.variants = {
      some: {
        active: true,
        ...(intent.sizes?.length ? { size: { in: intent.sizes } } : {}),
        ...(intent.colors?.length ? {
          OR: intent.colors.flatMap(catalogColorTerms).map((color) => ({
            color: { contains: color, mode: 'insensitive' as const },
          })),
        } : {}),
      },
    };
  }

  const tokens = (intent.query ?? '').split(/\s+/).map((token) => token.trim()).filter(Boolean).slice(0, 6);
  if (tokens.length) {
    where.AND = tokens.map((token) => ({
      OR: [
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

function availability(
  product: CatalogProduct,
  preorderAllowed: boolean,
  requested: Pick<SearchIntent, 'colors' | 'sizes'> = {},
): { available: boolean; preorder: boolean } {
  const hasVariantFilter = Boolean(requested.colors?.length || requested.sizes?.length);
  const matchingVariants = hasVariantFilter
    ? product.variants.filter((variant) =>
        (!requested.sizes?.length || requested.sizes.includes(variant.size ?? '')) &&
        (!requested.colors?.length || requested.colors.some((color) =>
          normalizeCatalogColor(color) === normalizeCatalogColor(variant.color ?? ''),
        )),
      )
    : product.variants;
  const inStock = hasVariantFilter
    ? matchingVariants.some((variant) => variant.stock > 0)
    : product.stock > 0 || matchingVariants.some((variant) => variant.stock > 0);
  const preorderCount = product.preorderEnabled ? Math.max(0, product.preorderLimit - product.preorderReserved) : 0;
  const preorder = !inStock && preorderAllowed && preorderCount > 0 && (!hasVariantFilter || matchingVariants.length > 0);
  return { available: inStock || preorder, preorder };
}

function isStorefrontVisible(product: CatalogProduct): boolean {
  return product.status === ProductPublicationStatus.PUBLISHED &&
    (!product.category || product.category.active);
}

function searchAllowsPreorder(intent: SearchIntent): boolean {
  return intent.preorderAllowed === true && intent.inStockOnly !== true;
}

function toPublic(product: CatalogProduct, preorderAllowed: boolean, requested: Pick<SearchIntent, 'colors' | 'sizes'> = {}) {
  return {
    ...publicProductDto(product),
    recommendationAvailability: availability(product, preorderAllowed, requested),
  };
}

function canonicalMetadataText(product: CatalogProduct): string {
  return JSON.stringify({
    translations: product.translations,
    attributes: product.attributes,
    material: product.material,
    category: product.category?.name,
    categorySlug: product.category?.slug,
    colors: product.variants.map((variant) => variant.color),
  }).toLocaleLowerCase();
}

const styleTerms: Record<NonNullable<StyleIntent['style']>, string[]> = {
  casual: ['casual', 'повседнев', 'kundalik'],
  old_money: ['old money', 'classic', 'классик', 'klassik'],
  minimalist: ['minimal', 'минимал', 'minimal'],
  formal: ['formal', 'office', 'делов', 'rasmiy'],
  streetwear: ['streetwear', 'street wear', 'стритвир'],
  evening: ['evening', 'вечер', 'kechki'],
  sport: ['sport', 'athleisure', 'спортив', 'sportiv'],
  classic: ['classic', 'классик', 'klassik'],
  unknown: [],
};

const seasonTerms: Record<NonNullable<StyleIntent['season']>, string[]> = {
  spring: ['spring', 'весна', 'bahor'],
  summer: ['summer', 'лето', 'yoz'],
  autumn: ['autumn', 'fall', 'осень', 'kuz'],
  winter: ['winter', 'зима', 'qish'],
};

function preferenceScore(product: CatalogProduct, intent: {
  style?: StyleIntent['style'];
  styles?: SearchIntent['styles'];
  season?: StyleIntent['season'] | SearchIntent['season'];
  preferredColors?: StyleIntent['preferredColors'];
  colors?: SearchIntent['colors'];
}): number {
  const metadata = canonicalMetadataText(product);
  const styles = [...(intent.styles ?? []), ...(intent.style ? [intent.style] : [])];
  const styleScore = styles.some((style) => styleTerms[style].some((term) => metadata.includes(term))) ? 3 : 0;
  const seasons: NonNullable<StyleIntent['season']>[] = typeof intent.season === 'string'
    ? [intent.season]
    : intent.season ?? [];
  const seasonScore = seasons.some((season) => seasonTerms[season].some((term) => metadata.includes(term))) ? 2 : 0;
  const colors = [...(intent.preferredColors ?? []), ...(intent.colors ?? [])];
  const colorScore = colors.some((color) =>
    product.variants.some((variant) => variant.color?.toLocaleLowerCase().includes(color.toLocaleLowerCase())),
  ) ? 1 : 0;
  return styleScore + seasonScore + colorScore;
}

function sortOrder(sort?: SearchIntent['sort']): Prisma.CommerceProductOrderByWithRelationInput {
  if (sort === 'price_asc') return { salePriceUzs: 'asc' };
  if (sort === 'price_desc') return { salePriceUzs: 'desc' };
  return { publishedAt: 'desc' };
}

function toProviderFailure(error: unknown): CatalogAiError['code'] {
  if (error instanceof CatalogAiError) return error.code;
  if (error instanceof z.ZodError) return 'INVALID_PROVIDER_RESPONSE';
  return 'PROVIDER_UNAVAILABLE';
}

function flattenLocalizedName(name: Prisma.JsonValue | null): string {
  if (typeof name === 'string') return name;
  if (!name || typeof name !== 'object' || Array.isArray(name)) return '';
  return Object.values(name).map((value) => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.values(value).filter((nested): nested is string => typeof nested === 'string').join(' ');
    }
    return '';
  }).join(' ').toLocaleLowerCase();
}

function roleForCategory(product: CatalogProduct): OutfitRole | undefined {
  const categoryText = `${product.category?.slug ?? ''} ${flattenLocalizedName(product.category?.name ?? null)}`.toLocaleLowerCase();
  if (/dress|one-piece|плать|ko.?ylak|ko.?ylaklar/.test(categoryText)) return 'dress';
  if (/shoe|sneaker|boot|footwear|обув|кроссов|туфл|пойабзал/.test(categoryText)) return 'shoes';
  if (/outerwear|coat|jacket|куртк|пальто|устки кийим|пиджак/.test(categoryText)) return 'outerwear';
  if (/accessor|jewel|belt|scarf|аксессуар|ремень|шарф/.test(categoryText)) return 'accessory';
  if (/bag|сумк|сумка/.test(categoryText)) return 'bag';
  if (/bottom|trouser|pant|jean|skirt|брюк|джинс|юбк|шим|юбка/.test(categoryText)) return 'bottom';
  if (/top|shirt|hoodie|sweater|blouse|t-shirt|рубаш|худи|свитер|блуз|футболк|футболка/.test(categoryText)) return 'top';
  return undefined;
}

function rolesForBase(base: CatalogProduct | undefined, intent: StyleIntent): OutfitRole[] {
  if (intent.requiredCategories?.length) return intent.requiredCategories;
  if (!base) {
    const roles: OutfitRole[] = ['top', 'bottom', 'shoes'];
    if (intent.season === 'autumn' || intent.season === 'winter') roles.push('outerwear');
    return roles;
  }
  const baseRole = roleForCategory(base);
  if (baseRole === 'bottom') return ['top', 'shoes', ...(intent.season === 'autumn' || intent.season === 'winter' ? ['outerwear' as const] : [])];
  if (baseRole === 'top') return ['bottom', 'shoes', ...(intent.season === 'autumn' || intent.season === 'winter' ? ['outerwear' as const] : [])];
  if (baseRole === 'dress') return ['shoes', 'bag', ...(intent.season === 'autumn' || intent.season === 'winter' ? ['outerwear' as const] : [])];
  if (baseRole === 'shoes') return ['top', 'bottom'];
  return ['top', 'bottom', 'shoes'];
}

function colorMatches(product: CatalogProduct, colors: string[]): boolean {
  if (!colors.length) return true;
  return product.variants.some((variant) =>
    colors.some((color) => normalizeCatalogColor(variant.color ?? '') === normalizeCatalogColor(color)),
  );
}

function sizeMatches(product: CatalogProduct, sizes: string[], preorderAllowed: boolean): boolean {
  if (!sizes.length) return true;
  return product.variants.some((variant) =>
    sizes.includes(variant.size ?? '') && (variant.stock > 0 || (preorderAllowed && product.preorderEnabled)),
  );
}

function chooseOutfit(
  products: CatalogProduct[],
  base: CatalogProduct | undefined,
  intent: StyleIntent,
): { items: Array<{ role: OutfitRole; product: CatalogProduct }>; total: Prisma.Decimal } {
  const roles = rolesForBase(base, intent).filter((role) => !intent.excludedCategories?.includes(role));
  const selected: Array<{ role: OutfitRole; product: CatalogProduct }> = [];
  const usedIds = new Set([base?.id].filter((id): id is string => Boolean(id)));
  let total = base ? new Prisma.Decimal(base.salePriceUzs) : new Prisma.Decimal(0);
  const maxBudget = intent.budgetUzs === undefined ? undefined : new Prisma.Decimal(intent.budgetUzs);

  for (const role of roles) {
    const candidates = products
      .filter((product) => {
      if (usedIds.has(product.id) || roleForCategory(product) !== role) return false;
      if (!availability(product, intent.preorderAllowed, {
        colors: intent.preferredColors,
        sizes: intent.sizes,
      }).available) return false;
      if (!colorMatches(product, intent.preferredColors ?? [])) return false;
      if (intent.excludedColors?.length && colorMatches(product, intent.excludedColors)) return false;
      if (!sizeMatches(product, intent.sizes ?? [], intent.preorderAllowed)) return false;
      const nextTotal = total.plus(product.salePriceUzs);
      return maxBudget === undefined || nextTotal.lte(maxBudget);
      })
      .sort((left, right) =>
        preferenceScore(right, intent) - preferenceScore(left, intent) ||
        new Prisma.Decimal(left.salePriceUzs).cmp(right.salePriceUzs),
      );
    const candidate = candidates[0];
    if (!candidate) continue;
    selected.push({ role, product: candidate });
    usedIds.add(candidate.id);
    total = total.plus(candidate.salePriceUzs);
  }
  return { items: selected, total };
}

export function createCatalogAssistantModule(dependencies: {
  ai?: CatalogAiService;
  isEnabled?: (flag: 'AI_SEARCH' | 'STYLE_ASSISTANT' | 'COMPLETE_THE_LOOK') => boolean;
} = {}): FastifyPluginAsync {
  const ai = dependencies.ai ?? catalogAiService;
  const isEnabled = dependencies.isEnabled ?? ((flag) => featureFlags.isEnabled(flag));

  return async (app) => {
    app.post('/products/ai-search', { config: { rateLimit } }, async (request, reply) => {
      if (!isEnabled('AI_SEARCH')) {
        return reply.status(403).send({ code: 'FEATURE_DISABLED' });
      }
      const parsedInput = searchRequestSchema.safeParse(request.body);
      if (!parsedInput.success) return reply.status(400).send({ code: 'INVALID_REQUEST' });
      const input = parsedInput.data;
      let intent: SearchIntent;
      let aiUsed = false;
      let fallbackReason: CatalogAiError['code'] | undefined;
      try {
        intent = mergeOverrides(await ai.parseSearchIntent(input.query, input.locale), input.overrides);
        aiUsed = true;
      } catch (error) {
        fallbackReason = toProviderFailure(error);
        intent = mergeOverrides({ query: input.query }, input.overrides);
      }

      const products = await app.prisma.commerceProduct.findMany({
        where: buildSearchWhere(intent),
        include: productInclude,
        orderBy: sortOrder(intent.sort),
        take: 96,
      });
      let eligible = products
        .filter((product) =>
          isStorefrontVisible(product) &&
          availability(product, searchAllowsPreorder(intent), intent).available,
        )
        .slice(0, 24);
      if (aiUsed && eligible.length === 0 && intent.query !== input.query) {
        const originalIntent = { ...intent, query: input.query };
        const fallbackProducts = await app.prisma.commerceProduct.findMany({
          where: buildSearchWhere(originalIntent),
          include: productInclude,
          orderBy: sortOrder(originalIntent.sort),
          take: 96,
        });
        const fallbackEligible = fallbackProducts
          .filter((product) =>
            isStorefrontVisible(product) &&
            availability(product, searchAllowsPreorder(originalIntent), originalIntent).available,
          )
          .slice(0, 24);
        if (fallbackEligible.length) {
          eligible = fallbackEligible;
          intent = originalIntent;
          aiUsed = false;
          fallbackReason = 'AI_NO_MATCHING_PRODUCTS';
        }
      }
      if (intent.sort !== 'price_asc' && intent.sort !== 'price_desc') {
        eligible = eligible
          .map((product, index) => ({ product, index, score: preferenceScore(product, intent) }))
          .sort((left, right) => right.score - left.score || left.index - right.index)
          .map(({ product }) => product);
      }
      return {
        items: eligible.map((product) => toPublic(product, searchAllowsPreorder(intent), intent)),
        intent,
        meta: { aiUsed, fallbackUsed: !aiUsed, ...(fallbackReason ? { fallbackReason } : {}) },
      };
    });

    app.post('/style-assistant/outfits', { config: { rateLimit } }, async (request, reply) => {
      if (!isEnabled('STYLE_ASSISTANT')) {
        return reply.status(403).send({ code: 'FEATURE_DISABLED' });
      }
      const parsedInput = styleRequestSchema.safeParse(request.body);
      if (!parsedInput.success) return reply.status(400).send({ code: 'INVALID_REQUEST' });
      const input = parsedInput.data;
      let intent: StyleIntent;
      let aiUsed = false;
      let fallbackReason: CatalogAiError['code'] | undefined;
      try {
        intent = await ai.parseStyleIntent(input.prompt, input.locale);
        aiUsed = true;
      } catch (error) {
        fallbackReason = toProviderFailure(error);
        intent = styleIntentSchema.parse({ preorderAllowed: false });
      }

      const base = input.baseProductSlug
        ? await app.prisma.commerceProduct.findFirst({
            where: { slug: input.baseProductSlug, status: ProductPublicationStatus.PUBLISHED, category: { active: true } },
            include: productInclude,
          })
        : undefined;
      if (input.baseProductSlug && !base) return reply.status(404).send({ code: 'PRODUCT_NOT_FOUND' });
      const products = await app.prisma.commerceProduct.findMany({
        where: {
          status: ProductPublicationStatus.PUBLISHED,
          category: { active: true },
          ...(intent.gender ? { attributes: { path: ['audience'], equals: intent.gender } } : {}),
          ...(base ? { id: { not: base.id } } : {}),
          ...(intent.preferredColors?.length ? {
            variants: {
              some: {
                active: true,
                OR: intent.preferredColors.flatMap(catalogColorTerms).map((color) => ({
                  color: { contains: color, mode: 'insensitive' as const },
                })),
                ...(intent.sizes?.length ? { size: { in: intent.sizes } } : {}),
              },
            },
          } : intent.sizes?.length ? {
            variants: { some: { active: true, size: { in: intent.sizes } } },
          } : {}),
        },
        include: productInclude,
        orderBy: { salePriceUzs: 'asc' },
        take: 120,
      });
      const chosen = chooseOutfit(products, base ?? undefined, intent);
      if (intent.budgetUzs !== undefined && chosen.items.length === 0) {
        return {
          title: 'Catalog outfit',
          explanation: 'No eligible catalog outfit fits the requested budget.',
          items: [],
          totalPriceUzs: '0',
          complete: false,
          withinBudget: false,
          intent,
          meta: { aiUsed, fallbackUsed: !aiUsed, ...(fallbackReason ? { fallbackReason } : {}) },
        };
      }

      return {
        title: intent.style && intent.style !== 'unknown' ? intent.style.replace('_', ' ') : 'Catalog outfit',
        explanation: aiUsed
          ? 'Items are selected from currently published catalog products using the parsed style constraints.'
          : 'AI interpretation is unavailable; these are eligible catalog picks without a claim that they match the prompt.',
        items: [
          ...(base ? [{ role: 'base' as const, reason: 'Your selected published product.', product: toPublic(base, intent.preorderAllowed) }] : []),
          ...chosen.items.map(({ role, product }) => ({
            role,
            reason: `Selected from the published ${role} category.`,
            product: toPublic(product, intent.preorderAllowed, { colors: intent.preferredColors, sizes: intent.sizes }),
          })),
        ],
        totalPriceUzs: chosen.total.toString(),
        complete: chosen.items.length === rolesForBase(base ?? undefined, intent).filter((role) => !intent.excludedCategories?.includes(role)).length,
        withinBudget: intent.budgetUzs === undefined || chosen.total.lte(intent.budgetUzs),
        intent,
        meta: { aiUsed, fallbackUsed: !aiUsed, ...(fallbackReason ? { fallbackReason } : {}) },
      };
    });

    app.get('/products/:identifier/complete-the-look', { config: { rateLimit } }, async (request, reply) => {
      if (!isEnabled('COMPLETE_THE_LOOK')) {
        return reply.status(403).send({ code: 'FEATURE_DISABLED' });
      }
      const { identifier } = request.params as { identifier: string };
      const base = await app.prisma.commerceProduct.findFirst({
        where: { OR: [{ slug: identifier }, { id: identifier }], status: ProductPublicationStatus.PUBLISHED, category: { active: true } },
        include: productInclude,
      });
      if (!base) return reply.status(404).send({ code: 'PRODUCT_NOT_FOUND' });

      const roles = rolesForBase(base, styleIntentSchema.parse({ preorderAllowed: false }));
      const candidates = await app.prisma.commerceProduct.findMany({
        where: {
          status: ProductPublicationStatus.PUBLISHED,
          category: { active: true },
          id: { not: base.id },
        },
        include: productInclude,
        orderBy: { salePriceUzs: 'asc' },
        take: 120,
      });
      const selected = new Set<string>();
      const items: Array<{ role: OutfitRole; product: ReturnType<typeof toPublic> }> = [];
      for (const role of roles) {
        const product = candidates.find((candidate) =>
          isStorefrontVisible(candidate) &&
          candidate.category !== null &&
          roleForCategory(candidate) === role &&
          !selected.has(candidate.id) &&
          availability(candidate, false).available,
        );
        if (!product) continue;
        selected.add(product.id);
        items.push({ role, product: toPublic(product, false) });
      }
      return { base: toPublic(base, false), items, complete: items.length === roles.length };
    });
  };
}

export const catalogAssistantModule = createCatalogAssistantModule();
