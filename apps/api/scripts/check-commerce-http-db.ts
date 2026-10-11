import assert from "node:assert/strict";
import Fastify from "fastify";
import fastifyJwt from "@fastify/jwt";
import fastifyMultipart from "@fastify/multipart";
import { AdminRole, PrismaClient, Role } from "@prisma/client";
import { createFittingRoomModule } from "../src/modules/commerce/fitting-room";
import { commerceModule } from "../src/modules/commerce";

const prisma = new PrismaClient();
const app = Fastify({ logger: false });
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const parserToken = "isolated-parser-http-integration-token";
const sourceProductIds = [`http-approve-${stamp}`, `http-reject-${stamp}`];
const importIds: string[] = [];
let productId: string | undefined;
let adminId: string | undefined;
let token: string | undefined;
let fittingRoomApp: ReturnType<typeof Fastify> | undefined;

function makeValidGlb() {
  const document = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [0, 0, 0],
      },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const json = Buffer.from(JSON.stringify(document));
  const paddedJson = Buffer.concat([
    json,
    Buffer.alloc((4 - (json.length % 4)) % 4, 0x20),
  ]);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + paddedJson.length + 8 + 36, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(paddedJson.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(36, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([
    header,
    jsonHeader,
    paddedJson,
    binaryHeader,
    Buffer.alloc(36),
  ]);
}

async function createPendingImport(sourceProductId: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/parser/imports",
    headers: { authorization: `Bearer ${parserToken}` },
    payload: {
      schemaVersion: 1,
      provider: "SOURCE_1688",
      sourceProductId,
      deduplicationKey: `SOURCE_1688:${sourceProductId}`,
      sourceUrl: `https://detail.1688.com/offer/${sourceProductId}.html`,
      sourceTitle: `HTTP integration ${sourceProductId}`,
      country: "CN",
      sourceAttributes: { composition: "cotton", care: "machine wash" },
      rawMetadata: { supplierSku: sourceProductId },
      fetchedAt: new Date().toISOString(),
    },
  });
  assert.equal(
    response.statusCode,
    201,
    `parser must create a pending import over HTTP: ${response.body}`,
  );
  const item = (response.json() as { item: { id: string } }).item;
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
    const listedNormalizedPayload = listedImport.normalizedPayload as Record<
      string,
      unknown
    >;
    assert.deepEqual(listedNormalizedPayload.sourceAttributes, {
      composition: "cotton",
      care: "machine wash",
    });
    assert.deepEqual(listedNormalizedPayload.rawMetadata, {
      supplierSku: sourceProductIds[0],
    });
    assert.equal(listedNormalizedPayload.country, "CN");
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

    const storageObjects = new Map<string, Buffer>();
    const fittingRoomStorage = {
      upload: async (data: Buffer, fileHash: string) => {
        const key = `private/fitting-room/${fileHash}.glb`;
        storageObjects.set(key, Buffer.from(data));
        return key;
      },
      signedUrl: (key: string) =>
        `https://signed-storage.example/${encodeURIComponent(key)}?signature=test-only`,
      delete: async (key: string) => {
        storageObjects.delete(key);
      },
    };
    fittingRoomApp = Fastify({ logger: false });
    fittingRoomApp.decorate("prisma", prisma);
    await fittingRoomApp.register(fastifyJwt, {
      secret: "integration-only-jwt-secret-not-for-production",
    });
    await fittingRoomApp.register(fastifyMultipart, {
      limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 0 },
    });
    await fittingRoomApp.register(
      createFittingRoomModule(() => fittingRoomStorage),
      {
        prefix: "/api/v1",
      },
    );
    await fittingRoomApp.ready();
    const fittingAuthorization = {
      authorization: `Bearer ${fittingRoomApp.jwt.sign({ userId: admin.id, role: "ADMIN" })}`,
    };
    const uploadUrl = `/api/v1/admin/products/${product.id}/fitting-room/assets?layer=BASE_TOP`;
    const unauthenticatedGlbUpload = await fittingRoomApp.inject({
      method: "POST",
      url: uploadUrl,
      headers: {
        "content-type": "multipart/form-data; boundary=averon-http-glb",
      },
      payload: Buffer.from("--averon-http-glb--\r\n"),
    });
    assert.equal(unauthenticatedGlbUpload.statusCode, 401);

    const glb = makeValidGlb();
    const multipartBody = Buffer.concat([
      Buffer.from(
        '--averon-http-glb\r\nContent-Disposition: form-data; name="file"; filename="fixture.glb"\r\nContent-Type: model/gltf-binary\r\n\r\n',
      ),
      glb,
      Buffer.from("\r\n--averon-http-glb--\r\n"),
    ]);
    const glbUpload = await fittingRoomApp.inject({
      method: "POST",
      url: uploadUrl,
      headers: {
        ...fittingAuthorization,
        "content-type": "multipart/form-data; boundary=averon-http-glb",
      },
      payload: multipartBody,
    });
    assert.equal(
      glbUpload.statusCode,
      201,
      `GLB upload must succeed: ${glbUpload.body}`,
    );
    const uploadedAsset = glbUpload.json() as {
      id: string;
      status: string;
      previewUrl: string;
    };
    assert.equal(uploadedAsset.status, "NEEDS_REVIEW");
    assert.match(
      uploadedAsset.previewUrl,
      /^https:\/\/signed-storage\.example\//,
    );
    const persistedAsset = await prisma.product3DAsset.findUnique({
      where: { id: uploadedAsset.id },
      select: { fileKey: true, fileHash: true, fileSize: true, status: true },
    });
    assert.ok(persistedAsset);
    assert.equal(persistedAsset.status, "NEEDS_REVIEW");
    assert.equal(persistedAsset.fileSize, glb.length);
    assert.deepEqual(storageObjects.get(persistedAsset.fileKey), glb);

    const assetReview = await fittingRoomApp.inject({
      method: "POST",
      url: `/api/v1/admin/fitting-room/assets/${uploadedAsset.id}/review`,
      headers: fittingAuthorization,
      payload: { action: "approve" },
    });
    assert.equal(assetReview.statusCode, 200, assetReview.body);
    assert.equal((assetReview.json() as { status: string }).status, "APPROVED");
    const persistedReviewedAsset = await prisma.product3DAsset.findUnique({
      where: { id: uploadedAsset.id },
      select: { status: true, reviewedById: true, approvedAt: true },
    });
    assert.equal(persistedReviewedAsset?.status, "APPROVED");
    assert.equal(persistedReviewedAsset?.reviewedById, admin.id);
    assert.ok(persistedReviewedAsset?.approvedAt);
    assert.ok(
      await prisma.auditLog.findFirst({
        where: {
          action: "PRODUCT_3D_ASSET_UPLOADED",
          resourceId: uploadedAsset.id,
          userId: admin.id,
        },
        select: { id: true },
      }),
    );
    assert.ok(
      await prisma.auditLog.findFirst({
        where: {
          action: "PRODUCT_3D_ASSET_APPROVED",
          resourceId: uploadedAsset.id,
          userId: admin.id,
        },
        select: { id: true },
      }),
    );

    console.log(
      "PASS PostgreSQL HTTP integration: parser-to-admin import review, localized composition/care, authenticated GLB upload/review and audit persistence",
    );
  } finally {
    await app.close().catch(() => undefined);
    await fittingRoomApp?.close().catch(() => undefined);
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
