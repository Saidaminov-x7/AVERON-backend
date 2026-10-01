import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';

export type ReviewState = 'FETCHED' | 'AI_PROCESSING' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';

const MAX_PRODUCT_SLUG_ATTEMPTS = 5;

const cyrillicTransliteration: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'yo',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  ў: 'o',
  ғ: 'g',
  қ: 'q',
  ҳ: 'h',
};

export function assertHumanApproval(current: ReviewState, actorId?: string): void {
  if (current !== 'PENDING_REVIEW') throw new Error('IMPORT_NOT_PENDING_REVIEW');
  if (!actorId) throw new Error('HUMAN_APPROVAL_REQUIRED');
}

export function calculateNetProfit(input: {
  totalRevenue: number;
  purchaseCost: number;
  cargoCost: number;
  paymentFee: number;
  deliveryCost: number;
  otherExpenses: number;
  refundAmount: number;
}): number {
  return input.totalRevenue - input.purchaseCost - input.cargoCost - input.paymentFee
    - input.deliveryCost - input.otherExpenses - input.refundAmount;
}

export function slugifyProduct(value: string): string {
  const transliterated = Array.from(value.toLowerCase(), (character) => (
    cyrillicTransliteration[character] ?? character
  )).join('');
  const normalized = transliterated
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ʻʼ’']/g, '');
  const slug = normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'product';
}

export function createProductSlug(title: string, suffix = randomInt(100_000, 1_000_000).toString()): string {
  if (!/^\d{6,}$/.test(suffix)) throw new Error('INVALID_PRODUCT_SLUG_SUFFIX');
  const base = slugifyProduct(title).slice(0, 180).replace(/-+$/g, '') || 'product';
  return `${base}-${suffix}`;
}

export class ProductSlugCollisionError extends Error {
  constructor() {
    super('PRODUCT_SLUG_COLLISION_LIMIT');
    this.name = 'ProductSlugCollisionError';
  }
}

function isProductSlugCollision(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }

  const target = error.meta?.target;
  const isSlugTarget = (value: unknown) => (
    typeof value === 'string' && /(?:^|[^a-z0-9])slug(?:$|[^a-z0-9])/i.test(value)
  );
  if (Array.isArray(target)) return target.some(isSlugTarget);
  return isSlugTarget(target);
}

export async function createProductWithUniqueSlug<T>(
  title: string,
  create: (slug: string) => Promise<T>,
  suffixGenerator: () => string = () => randomInt(100_000, 1_000_000).toString(),
): Promise<T> {
  for (let attempt = 0; attempt < MAX_PRODUCT_SLUG_ATTEMPTS; attempt += 1) {
    try {
      return await create(createProductSlug(title, suffixGenerator()));
    } catch (error) {
      if (!isProductSlugCollision(error)) throw error;
      if (attempt === MAX_PRODUCT_SLUG_ATTEMPTS - 1) {
        throw new ProductSlugCollisionError();
      }
    }
  }

  throw new ProductSlugCollisionError();
}
