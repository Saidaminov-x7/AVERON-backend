import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { productReviewsModule } from '../product-reviews';

const mocks = vi.hoisted(() => ({
  orderItem: {
    id: '00000000-0000-4000-8000-000000000001',
    orderId: '00000000-0000-4000-8000-000000000002',
    productId: '00000000-0000-4000-8000-000000000003',
    product: { id: '00000000-0000-4000-8000-000000000003', slug: 'linen-shirt' },
    variantSnapshot: { size: 'M', color: 'Blue', sku: 'INTERNAL-SKU' },
    order: {
      orderNumber: 'AV-12345',
      userId: '00000000-0000-4000-8000-000000000004',
      status: 'COMPLETED',
      delivery: { status: 'DELIVERED' },
    },
    review: null as null | { status: string; deletedAt: Date | null },
  },
  review: { id: '00000000-0000-4000-8000-000000000005', status: 'PENDING', createdAt: new Date() },
  reviewStatus: 'PENDING',
  createError: null as null | { code: string },
  updateCount: 1,
}));

vi.mock('../../../lib/authMiddleware', () => ({
  authMiddleware: async (request: { headers: Record<string, string | string[] | undefined> }, reply: { status: (code: number) => { send: (body: unknown) => unknown } }) => {
    if (!request.headers['x-test-user']) return reply.status(401).send({ code: 'UNAUTHORIZED' });
    Object.assign(request, { user: { userId: String(request.headers['x-test-user']), role: 'USER' } });
  },
}));

vi.mock('../../../lib/adminMiddleware', () => ({
  adminMiddleware: async (request: { headers: Record<string, string | string[] | undefined> }, reply: { status: (code: number) => { send: (body: unknown) => unknown } }) => {
    if (request.headers['x-test-role'] !== 'admin') return reply.status(403).send({ code: 'FORBIDDEN' });
    Object.assign(request, { user: { userId: '00000000-0000-4000-8000-000000000006', role: 'ADMIN', adminRole: 'ADMIN' } });
  },
}));

function createApp() {
  const prisma = {
    commerceOrderItem: {
      findUnique: vi.fn(async () => ({ ...mocks.orderItem, order: { ...mocks.orderItem.order, status: mocks.orderItem.order.status } })),
    },
    media: { findMany: vi.fn(async () => []) },
    commerceProduct: { findFirst: vi.fn(async () => ({ id: mocks.orderItem.productId })) },
    commerceProductReview: {
      aggregate: vi.fn(async () => ({ _avg: { rating: 4.6 }, _count: { id: 2 } })),
      groupBy: vi.fn()
        .mockResolvedValueOnce([{ rating: 5, _count: { id: 1 } }, { rating: 4, _count: { id: 1 } }])
        .mockResolvedValueOnce([{ fitFeedback: 'TRUE_TO_SIZE', _count: { id: 1 } }]),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => {
        if (mocks.createError) throw mocks.createError;
        return mocks.review;
      }),
      findFirst: vi.fn(async () => ({ id: mocks.review.id, status: mocks.reviewStatus, productId: mocks.orderItem.productId })),
      updateMany: vi.fn(async () => ({ count: mocks.updateCount })),
    },
    commerceProductReviewMedia: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 1 })),
    },
    auditLog: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
  };
  const app = Fastify();
  app.decorate('prisma', prisma as never);
  return { app, prisma };
}

async function ready(app: ReturnType<typeof Fastify>) {
  await app.register(productReviewsModule, { prefix: '/api/v1' });
  await app.ready();
}

const reviewPayload = {
  orderItemId: mocks.orderItem.id,
  orderNumber: 'AV-12345',
  rating: 5,
  title: 'Great fit',
  comment: 'The fabric and fit are excellent.',
  fitFeedback: 'TRUE_TO_SIZE',
};

describe('verified product reviews', () => {
  beforeEach(() => {
    mocks.orderItem.order.userId = '00000000-0000-4000-8000-000000000004';
    mocks.orderItem.order.status = 'COMPLETED';
    mocks.orderItem.order.delivery = { status: 'DELIVERED' };
    mocks.orderItem.review = null;
    mocks.reviewStatus = 'PENDING';
    mocks.createError = null;
    mocks.updateCount = 1;
  });

  it('requires authentication and refuses unverified client claims', async () => {
    const { app, prisma } = createApp();
    await ready(app);
    const url = '/api/v1/products/linen-shirt/reviews';
    expect((await app.inject({ method: 'POST', url, payload: reviewPayload })).statusCode).toBe(401);
    const response = await app.inject({
      method: 'POST', url,
      headers: { 'x-test-user': mocks.orderItem.order.userId },
      payload: { ...reviewPayload, verifiedPurchase: true },
    });
    expect(response.statusCode).toBe(400);
    expect(prisma.commerceProductReview.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('derives verified purchase from the authenticated delivered order and snapshots the purchase variant', async () => {
    const { app, prisma } = createApp();
    await ready(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/products/linen-shirt/reviews',
      headers: { 'x-test-user': mocks.orderItem.order.userId },
      payload: reviewPayload,
    });
    expect(response.statusCode).toBe(201);
    expect(prisma.commerceProductReview.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        orderId: mocks.orderItem.orderId,
        productId: mocks.orderItem.productId,
        userId: mocks.orderItem.order.userId,
        verifiedPurchase: true,
        orderItemId: mocks.orderItem.id,
      }),
    }));
    await app.close();
  });

  it.each([
    ['cancelled order', 'CANCELLED', { status: 'CANCELLED' }],
    ['undelivered order', 'PAID', { status: 'PENDING' }],
  ])('rejects an ineligible %s', async (_label, status, delivery) => {
    mocks.orderItem.order.status = status;
    mocks.orderItem.order.delivery = delivery;
    const { app, prisma } = createApp();
    await ready(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/products/linen-shirt/reviews',
      headers: { 'x-test-user': mocks.orderItem.order.userId },
      payload: reviewPayload,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'ORDER_NOT_DELIVERED' });
    expect(prisma.commerceProductReview.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('prevents another customer from claiming an order item', async () => {
    const { app, prisma } = createApp();
    await ready(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/products/linen-shirt/reviews',
      headers: { 'x-test-user': '00000000-0000-4000-8000-000000000099' },
      payload: reviewPayload,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'PURCHASE_NOT_FOUND' });
    expect(prisma.commerceProductReview.create).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([0, -1, 6, 4.5, '5', Number.NaN])('rejects invalid rating %s', async (rating) => {
    const { app, prisma } = createApp();
    await ready(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/products/linen-shirt/reviews',
      headers: { 'x-test-user': mocks.orderItem.order.userId },
      payload: { ...reviewPayload, rating },
    });
    expect(response.statusCode).toBe(400);
    expect(prisma.commerceProductReview.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects oversized or control-character review content', async () => {
    const { app, prisma } = createApp();
    await ready(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/products/linen-shirt/reviews',
      headers: { 'x-test-user': mocks.orderItem.order.userId },
      payload: { ...reviewPayload, comment: 'x'.repeat(3001) },
    });
    expect(response.statusCode).toBe(400);
    expect(prisma.commerceProductReview.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects concurrent duplicate attempts using the database unique key', async () => {
    const { app, prisma } = createApp();
    let committed = false;
    prisma.commerceProductReview.create.mockImplementation(async () => {
      if (committed) throw { code: 'P2002' };
      committed = true;
      return mocks.review as never;
    });
    await ready(app);
    const submit = () => app.inject({
      method: 'POST',
      url: '/api/v1/products/linen-shirt/reviews',
      headers: { 'x-test-user': mocks.orderItem.order.userId },
      payload: reviewPayload,
    });
    const responses = await Promise.all([submit(), submit()]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.statusCode === 409)?.json()).toMatchObject({ code: 'REVIEW_ALREADY_EXISTS' });
    expect(prisma.commerceProductReview.create).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('rejects media that is not owned by the authenticated reviewer', async () => {
    const { app, prisma } = createApp();
    await ready(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/products/linen-shirt/reviews',
      headers: { 'x-test-user': mocks.orderItem.order.userId },
      payload: { ...reviewPayload, mediaIds: ['00000000-0000-4000-8000-000000000010'] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_REVIEW_MEDIA' });
    expect(prisma.media.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        ownerId: mocks.orderItem.order.userId,
        mimeType: { in: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] },
      }),
    }));
    expect(prisma.commerceProductReview.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('only permits the author to edit or delete and resubmits published edits for moderation', async () => {
    const { app, prisma } = createApp();
    prisma.commerceProductReview.findFirst
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({ id: mocks.review.id, status: 'PUBLISHED', productId: mocks.orderItem.productId } as never);
    await ready(app);
    const otherUser = await app.inject({
      method: 'PATCH', url: `/api/v1/reviews/me/${mocks.review.id}`,
      headers: { 'x-test-user': '00000000-0000-4000-8000-000000000099' },
      payload: { comment: 'Changed comment' },
    });
    expect(otherUser.statusCode).toBe(404);
    const edit = await app.inject({
      method: 'PATCH', url: `/api/v1/reviews/me/${mocks.review.id}`,
      headers: { 'x-test-user': mocks.orderItem.order.userId },
      payload: { comment: 'Changed comment' },
    });
    expect(edit.statusCode).toBe(200);
    expect(prisma.commerceProductReview.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PENDING', moderatedAt: null, moderatedById: null }),
    }));
    await app.close();
  });

  it('returns rejected edits to pending moderation', async () => {
    mocks.reviewStatus = 'REJECTED';
    const { app, prisma } = createApp();
    prisma.commerceProductReview.findFirst.mockResolvedValue({
      id: mocks.review.id,
      status: 'REJECTED',
      productId: mocks.orderItem.productId,
    } as never);
    await ready(app);
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/reviews/me/${mocks.review.id}`,
      headers: { 'x-test-user': mocks.orderItem.order.userId },
      payload: { comment: 'A revised review after rejection.' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'PENDING' });
    expect(prisma.commerceProductReview.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PENDING', moderatedAt: null, moderatedById: null }),
    }));
    await app.close();
  });

  it('soft-deletes only the current customer review', async () => {
    const { app, prisma } = createApp();
    prisma.commerceProductReview.updateMany.mockResolvedValueOnce({ count: 0 } as never);
    await ready(app);
    const response = await app.inject({
      method: 'DELETE', url: `/api/v1/reviews/me/${mocks.review.id}`,
      headers: { 'x-test-user': mocks.orderItem.order.userId },
    });
    expect(response.statusCode).toBe(404);
    expect(prisma.commerceProductReview.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: mocks.orderItem.order.userId }),
      data: expect.objectContaining({ deletedAt: expect.any(Date) }),
    }));
    await app.close();
  });

  it('restores an own deleted review as pending instead of failing the order-item unique key', async () => {
    const { app, prisma } = createApp();
    prisma.commerceProductReview.findUnique.mockResolvedValue({
      id: mocks.review.id,
      userId: mocks.orderItem.order.userId,
      deletedAt: new Date(),
      createdAt: new Date(),
    } as never);
    await ready(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/products/linen-shirt/reviews',
      headers: { 'x-test-user': mocks.orderItem.order.userId },
      payload: reviewPayload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: mocks.review.id, status: 'PENDING' });
    expect(prisma.commerceProductReview.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ deletedAt: { not: null }, userId: mocks.orderItem.order.userId }),
      data: expect.objectContaining({ deletedAt: null, status: 'PENDING', verifiedPurchase: true }),
    }));
    await app.close();
  });

  it('calculates public rating statistics only from published reviews', async () => {
    const { app, prisma } = createApp();
    await ready(app);
    const response = await app.inject({ method: 'GET', url: '/api/v1/products/linen-shirt/reviews' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      summary: { averageRating: 4.6, reviewCount: 2, distribution: { 4: 1, 5: 1 } },
    });
    for (const call of prisma.commerceProductReview.groupBy.mock.calls) {
      expect(call[0]).toMatchObject({ where: { status: 'PUBLISHED', deletedAt: null } });
    }
    await app.close();
  });

  it('requires an admin and rejects invalid moderation transitions', async () => {
    const { app, prisma } = createApp();
    await ready(app);
    const url = `/api/v1/admin/reviews/${mocks.review.id}/moderation`;
    expect((await app.inject({ method: 'PATCH', url, payload: { status: 'PUBLISHED' } })).statusCode).toBe(403);
    mocks.reviewStatus = 'REJECTED';
    const invalid = await app.inject({
      method: 'PATCH', url,
      headers: { 'x-test-role': 'admin' },
      payload: { status: 'PUBLISHED' },
    });
    expect(invalid.statusCode).toBe(409);
    expect(invalid.json()).toMatchObject({ code: 'INVALID_MODERATION_TRANSITION' });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    await app.close();
  });

  it('audits valid admin moderation', async () => {
    const { app, prisma } = createApp();
    await ready(app);
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/reviews/${mocks.review.id}/moderation`,
      headers: { 'x-test-role': 'admin' },
      payload: { status: 'PUBLISHED' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'PUBLISHED', moderatedAt: expect.any(String) });
    expect(prisma.auditLog.create).toHaveBeenCalledOnce();
    await app.close();
  });
});
