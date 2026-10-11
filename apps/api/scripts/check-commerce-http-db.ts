import assert from "node:assert/strict";
import Fastify from "fastify";
import fastifyJwt from "@fastify/jwt";
import { AdminRole, PrismaClient, Role } from "@prisma/client";
import { commerceModule } from "../src/modules/commerce";

const prisma = new PrismaClient();
const app = Fastify({ logger: false });
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const sourceProductIds = [`http-approve-${stamp}`, `http-reject-${stamp}`];
const importIds: string[] = [];
let productId: string | undefined;
let adminId: string | undefined;
let token: string | undefined;

async function createPendingImport(sourceProductId: string) {
  const item = await prisma.importedProduct.create({
    data: {
      source: "SOURCE_1688",
      sourceProductId,
      sourceUrl: `https://detail.1688.com/offer/${sourceProductId}.html`,
      originalTitle: `HTTP integration ${sourceProductId}`,
      sourceMetadata: { composition: "cotton", care: "machine wash" },
      normalizedPayload: {
        title: `HTTP integration ${sourceProductId}`,
        country: "CN",
        variants: [],
      },
      aiPayload: { ru: { title: `HTTP integration ${sourceProductId}` } },
    },
  });
  importIds.push(item.id);
  return item;
}

async function main() {
  try {
    const admin = await prisma.user.create({
      data: {
        email: `http-integration-${stamp}@averon.invalid`,
        phone: `+998${String(Date.now() % 1_000_000_000).padStart(9, "0")}`,
        passwordHash: "integration-only-not-a-credential",
        name: "AVERON HTTP Integration Admin",
        role: Role.ADMIN,
        adminRole: AdminRole.SUPER_ADMIN,
        verified: true,
      },
      select: { id: true },
    });
    adminId = admin.id;

    app.decorate("prisma", prisma);
    await app.register(fastifyJwt, {
      secret: "integration-only-jwt-secret-not-for-production",
    });
    await app.register(commerceModule, { prefix: "/api/v1" });
    await app.ready();
    token = app.jwt.sign({ userId: admin.id, role: "ADMIN" });
    const authorization = { authorization: `Bearer ${token}` };

    const [sequence] = await prisma.$queryRaw<Array<{ id: bigint }>>`
    SELECT nextval('"CommerceProduct_public_id_seq"') AS id
  `;
    const publicId = `AVR-${sequence.id.toString().padStart(15, "0")}`;
    const product = await prisma.commerceProduct.create({
      data: {
        country: "CN",
        slug: `http-integration-${stamp}`,
        publicId,
        legacyPublicId: `http-integration-legacy-${stamp}`,
        translations: {
          ru: { title: "HTTP integration cotton shirt" },
          uz: { title: "HTTP integration paxta ko‘ylagi" },
          en: { title: "HTTP integration cotton shirt" },
        },
        description: { ru: "before", uz: "oldin", en: "before" },
        attributes: {},
        source: "MANUAL",
        sourceProductId: `http-manual-${stamp}`,
        salePriceUzs: "1000",
        status: "PUBLISHED",
        publishedAt: new Date(),
      },
      select: { id: true, publicId: true },
    });
    productId = product.id;

    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/v1/admin/imports",
    });
    assert.equal(
      unauthenticated.statusCode,
      401,
      "admin import listing must reject unauthenticated requests",
    );

    const approvedImport = await createPendingImport(sourceProductIds[0]);
    const rejectedImport = await createPendingImport(sourceProductIds[1]);

    const pendingList = await app.inject({
      method: "GET",
      url: `/api/v1/admin/imports?status=PENDING_REVIEW&q=${encodeURIComponent(sourceProductIds[0])}`,
      headers: authorization,
    });
    assert.equal(
      pendingList.statusCode,
      200,
      "authenticated admin must be able to inspect pending import details",
    );
    const pendingBody = pendingList.json() as {
      items: Array<Record<string, unknown>>;
    };
    const listedImport = pendingBody.items.find(
      (item) => item.id === approvedImport.id,
    );
    assert.ok(
      listedImport,
      "pending import is visible in the authenticated review queue",
    );
    assert.deepEqual(listedImport.sourceMetadata, {
      composition: "cotton",
      care: "machine wash",
    });
    assert.equal(
      listedImport.status,
      "PENDING_REVIEW",
      "reading import details must not mutate its status",
    );

    const approval = await app.inject({
      method: "POST",
      url: `/api/v1/admin/imports/${approvedImport.id}/approve`,
      headers: authorization,
      payload: {
        translations: {
          ru: { title: "Одобренная рубашка", description: "Описание" },
          uz: { title: "Tasdiqlangan ko‘ylak", description: "Tavsif" },
          en: { title: "Approved shirt", description: "Description" },
        },
        country: "CN",
        salePriceUzs: 42000,
        publish: false,
      },
    });
    assert.equal(
      approval.statusCode,
      200,
      `authenticated approval must succeed: ${approval.body}`,
    );
    const approvedProductId = (
      approval.json() as { id: string; status: string }
    ).id;
    const persistedApproval = await prisma.importedProduct.findUnique({
      where: { id: approvedImport.id },
      select: {
        status: true,
        reviewedById: true,
        product: { select: { id: true, status: true, salePriceUzs: true } },
      },
    });
    assert.equal(persistedApproval?.status, "APPROVED");
    assert.equal(persistedApproval?.reviewedById, admin.id);
    assert.equal(persistedApproval?.product?.id, approvedProductId);
    assert.equal(
      persistedApproval?.product?.status,
      "DRAFT",
      "publish=false must keep the approved product as a draft",
    );
    assert.equal(persistedApproval?.product?.salePriceUzs.toString(), "42000");
    assert.ok(
      await prisma.auditLog.findFirst({
        where: {
          action: "PRODUCT_IMPORT_APPROVED",
          resourceId: approvedImport.id,
          userId: admin.id,
        },
        select: { id: true },
      }),
      "approval must persist an audit record",
    );

    const rejection = await app.inject({
      method: "POST",
      url: `/api/v1/admin/imports/${rejectedImport.id}/reject`,
      headers: authorization,
      payload: { reason: "Invalid source listing" },
    });
    assert.equal(
      rejection.statusCode,
      200,
      `authenticated rejection must succeed: ${rejection.body}`,
    );
    const persistedRejection = await prisma.importedProduct.findUnique({
      where: { id: rejectedImport.id },
      select: {
        status: true,
        rejectionReason: true,
        reviewedById: true,
        reviewedAt: true,
      },
    });
    assert.equal(persistedRejection?.status, "REJECTED");
    assert.equal(persistedRejection?.rejectionReason, "Invalid source listing");
    assert.equal(persistedRejection?.reviewedById, admin.id);
    assert.ok(persistedRejection?.reviewedAt);
    assert.ok(
      await prisma.auditLog.findFirst({
        where: {
          action: "PRODUCT_IMPORT_REJECTED",
          resourceId: rejectedImport.id,
          userId: admin.id,
        },
        select: { id: true },
      }),
      "rejection must persist an audit record",
    );

    const updatedProduct = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/products/${product.id}`,
      headers: authorization,
      payload: {
        composition: "Хлопок 100%",
        compositionUz: "100% paxta",
        compositionEn: "100% cotton",
        careInstructions: "Машинная стирка при 30 °C",
        careInstructionsUz: "30 °C da mashinada yuvish",
        careInstructionsEn: "Machine wash at 30 °C",
      },
    });
    assert.equal(
      updatedProduct.statusCode,
      200,
      `localized product attribute update must succeed: ${updatedProduct.body}`,
    );
    const persistedAttributes = await prisma.commerceProduct.findUnique({
      where: { id: product.id },
      select: { attributes: true },
    });
    assert.deepEqual(persistedAttributes?.attributes, {
      composition: { ru: "Хлопок 100%", uz: "100% paxta", en: "100% cotton" },
      careInstructions: {
        ru: "Машинная стирка при 30 °C",
        uz: "30 °C da mashinada yuvish",
        en: "Machine wash at 30 °C",
      },
    });
    const publicRead = await app.inject({
      method: "GET",
      url: `/api/v1/products/${product.publicId}`,
    });
    assert.equal(
      publicRead.statusCode,
      200,
      `public product read must succeed: ${publicRead.body}`,
    );
    assert.deepEqual(
      (publicRead.json() as { attributes: unknown }).attributes,
      persistedAttributes?.attributes,
    );

    console.log(
      "PASS authenticated PostgreSQL HTTP integration: import details, draft approval, rejection audit, localized composition/care save and public read",
    );
  } finally {
    await app.close().catch(() => undefined);
    if (productId)
      await prisma.commerceProduct
        .deleteMany({ where: { id: productId } })
        .catch(() => undefined);
    if (importIds.length)
      await prisma.importedProduct
        .deleteMany({ where: { id: { in: importIds } } })
        .catch(() => undefined);
    if (adminId) {
      await prisma.auditLog
        .deleteMany({ where: { userId: adminId } })
        .catch(() => undefined);
      await prisma.user
        .deleteMany({ where: { id: adminId } })
        .catch(() => undefined);
    }
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
