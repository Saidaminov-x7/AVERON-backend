import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  assertHumanApproval,
  calculateNetProfit,
  createProductWithUniquePublicId,
  createPublicProductId,
  createProductSlug,
  ProductPublicIdCollisionError,
  slugifyProduct,
} from '../rules';

describe('AVERON commerce invariants', () => {
  it('forbids publication without a human actor', () => {
    expect(() => assertHumanApproval('PENDING_REVIEW')).toThrow('HUMAN_APPROVAL_REQUIRED');
  });

  it('forbids approving an import outside pending review', () => {
    expect(() => assertHumanApproval('APPROVED', 'admin-id')).toThrow('IMPORT_NOT_PENDING_REVIEW');
  });

  it('calculates net profit from actual costs and refunds', () => {
    expect(calculateNetProfit({ totalRevenue: 300000, purchaseCost: 150000, cargoCost: 30000, paymentFee: 5000, deliveryCost: 10000, otherExpenses: 5000, refundAmount: 0 })).toBe(100000);
  });

  it('transliterates Russian product titles into readable ASCII slugs', () => {
    expect(slugifyProduct('Тест')).toBe('test');
    expect(slugifyProduct('Ёлка')).toBe('yolka');
    expect(slugifyProduct('Мужская куртка')).toBe('muzhskaya-kurtka');
    expect(slugifyProduct('Телефон')).toBe('telefon');
    expect(slugifyProduct('Кроссовки Nike Air Max')).toBe('krossovki-nike-air-max');
    expect(slugifyProduct("Ўзбекистон Ғурури")).toBe('ozbekiston-gururi');
  });

  it('normalizes special characters and falls back for empty transliterations', () => {
    expect(slugifyProduct('  Héllo___World!!  ')).toBe('hello-world');
    expect(slugifyProduct('ъь')).toBe('product');
  });

  it.each([
    ['Caffè Italiano', 'caffe-italiano'],
    ['Çocuk Giyim', 'cocuk-giyim'],
    ['Şık Elbise', 'sik-elbise'],
    ['İstanbul', 'istanbul'],
    ['Ürün', 'urun'],
    ['男士夹克', 'product'],
  ])('normalizes international product title %s to %s', (title, expected) => {
    expect(slugifyProduct(title)).toBe(expected);
  });

  it('adds a numeric suffix of at least six digits and uses the fallback base', () => {
    const slug = createProductSlug('Тест', '583921');
    expect(slug).toBe('test-583921');
    expect(slug).toMatch(/^[a-z0-9-]+-\d{6,}$/);
    expect(createProductSlug('Тест')).toMatch(/^test-\d{6}$/);
    expect(createProductSlug('ъь', '123456')).toBe('product-123456');
    expect(() => createProductSlug('Тест', '123')).toThrow('INVALID_PRODUCT_SLUG_SUFFIX');
  });

  it('generates public product IDs in the requested compact format', () => {
    expect(createPublicProductId()).toMatch(/^[a-z0-9]{4}(?:-[a-z0-9]{4}){3}$/);
  });

  it('retries a public ID after Prisma reports a unique collision', async () => {
    let attempts = 0;
    const result = await createProductWithUniquePublicId(
      'Тест',
      async (publicId) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: '5.22.0',
            meta: { target: ['publicId'] },
          });
        }
        return publicId;
      },
      (() => {
        const ids = ['aaaa-bbbb-cccc-dddd', 'eeee-ffff-gggg-hhhh'];
        return () => ids.shift()!;
      })(),
    );

    expect(result).toBe('eeee-ffff-gggg-hhhh');
    expect(attempts).toBe(2);
  });

  it('retries a collision on the legacy title slug as well', async () => {
    let attempts = 0;
    const slugs: string[] = [];
    await createProductWithUniquePublicId('Тест', async (publicId, slug) => {
      attempts += 1;
      slugs.push(slug);
      if (attempts === 1) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.22.0',
          meta: { target: ['slug'] },
        });
      }
      return publicId;
    }, (() => {
      const ids = ['aaaa-bbbb-cccc-dddd', 'eeee-ffff-gggg-hhhh'];
      return () => ids.shift()!;
    })());

    expect(attempts).toBe(2);
    expect(slugs[0]).toMatch(/^test-\d{6}$/);
    expect(slugs[1]).toMatch(/^test-\d{6}$/);
  });

  it('does not retry collisions on a different unique constraint', async () => {
    const error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '5.22.0',
      meta: { target: ['source', 'sourceProductId'] },
    });
    const create = async () => {
      throw error;
    };

    await expect(createProductWithUniquePublicId('Тест', create, () => 'aaaa-bbbb-cccc-dddd')).rejects.toBe(error);
  });

  it('fails with a controlled error after five public identifier collision attempts', async () => {
    let attempts = 0;
    const create = async () => {
      attempts += 1;
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.22.0',
        meta: { target: 'CommerceProduct_publicId_key' },
      });
    };

    await expect(createProductWithUniquePublicId('Тест', create, () => 'aaaa-bbbb-cccc-dddd'))
      .rejects.toBeInstanceOf(ProductPublicIdCollisionError);
    expect(attempts).toBe(5);
  });
});
