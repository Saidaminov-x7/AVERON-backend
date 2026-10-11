import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const legacyId = 'a42h-nbsq-o1fp-awaz';
const localizedAttributes = {
  composition: { ru: 'Хлопок 100%', uz: '100% paxta', en: '100% cotton' },
  careInstructions: { ru: 'Машинная стирка', uz: 'Mashinada yuvish', en: 'Machine wash' },
};
let createdId;
const importedIds = [];
const auditResourceIds = [];
let fittingRoomAssetId;

async function createImport(suffix, overrides = {}) {
  const sourceProductId = `db-integration-${suffix}-${Date.now()}`;
  const imported = await prisma.importedProduct.create({
    data: {
      source: 'SOURCE_1688',
      sourceProductId,
      sourceUrl: `https://example.invalid/products/${sourceProductId}`,
      originalTitle: `DB integration import ${suffix}`,
      sourceMetadata: { color: 'dark blue', size: 'M' },
      normalizedPayload: { title: `DB integration import ${suffix}`, variants: [{ color: 'dark blue', size: 'M', stock: 2 }] },
      aiPayload: { title: `DB integration import ${suffix}` },
      ...overrides,
    },
  });
  importedIds.push(imported.id);
  return imported;
}

async function reviewImport(importId, status, reason) {
  return prisma.$transaction(async (tx) => {
    const changed = await tx.importedProduct.updateMany({
      where: { id: importId, status: 'PENDING_REVIEW' },
      data: { status, reviewedAt: new Date(), rejectionReason: reason ?? null },
    });
    if (changed.count !== 1) return false;

    await tx.auditLog.create({
      data: {
        action: status === 'APPROVED' ? 'PRODUCT_IMPORT_APPROVED' : 'PRODUCT_IMPORT_REJECTED',
        resource: 'ImportedProduct',
        resourceId: importId,
        meta: reason ? { reason } : {},
      },
    });
    auditResourceIds.push(importId);
    return true;
  });
}

try {
  const migrated = await prisma.commerceProduct.findUnique({
    where: { legacyPublicId: legacyId },
    select: { id: true, publicId: true, legacyPublicId: true },
  });

  assert.ok(migrated, 'legacy product identifier was not preserved by the migration');
  assert.equal(migrated.publicId, 'AVR-000000000000001');
  assert.equal(migrated.legacyPublicId, legacyId);

  const [sequence] = await prisma.$queryRaw`
    SELECT nextval('"CommerceProduct_public_id_seq"') AS id
  `;
  assert.equal(sequence.id, 2n, 'new product sequence must continue after migrated rows');
  const publicId = `AVR-${sequence.id.toString().padStart(15, '0')}`;
  assert.equal(publicId, 'AVR-000000000000002');

  const created = await prisma.commerceProduct.create({
    data: {
      country: 'CN',
      slug: `db-integration-${Date.now()}`,
      publicId,
      legacyPublicId: `db-integration-legacy-${Date.now()}`,
      translations: { en: { title: 'DB integration fixture' } },
      attributes: localizedAttributes,
      source: 'MANUAL',
      sourceProductId: `db-integration-${Date.now()}`,
      salePriceUzs: '1',
    },
    select: { id: true, publicId: true, legacyPublicId: true },
  });
  createdId = created.id;

  const reloaded = await prisma.commerceProduct.findUnique({
    where: { id: created.id },
    select: { attributes: true },
  });
  assert.deepEqual(reloaded?.attributes, localizedAttributes, 'localized composition and care were not saved and reloaded');

  const legacyLookup = await prisma.commerceProduct.findFirst({
    where: {
      OR: [
        { id: legacyId },
        { publicId: legacyId },
        { legacyPublicId: legacyId },
        { slug: legacyId },
      ],
    },
    select: { id: true },
  });
  assert.equal(legacyLookup?.id, migrated.id, 'legacy product lookup did not resolve to the migrated row');

  const pendingImport = await createImport('details');
  const details = await prisma.importedProduct.findUnique({
    where: { id: pendingImport.id },
    select: { sourceMetadata: true, normalizedPayload: true, aiPayload: true, status: true },
  });
  assert.equal(details?.status, 'PENDING_REVIEW');
  assert.deepEqual(details?.sourceMetadata, { color: 'dark blue', size: 'M' });
  assert.deepEqual(details?.normalizedPayload, {
    title: 'DB integration import details',
    variants: [{ color: 'dark blue', size: 'M', stock: 2 }],
  });

  const approvedImport = await createImport('approve');
  const approval = await prisma.$transaction(async (tx) => {
    const [nextSequence] = await tx.$queryRaw`SELECT nextval('"CommerceProduct_public_id_seq"') AS id`;
    const approvedProduct = await tx.commerceProduct.create({
      data: {
        country: 'CN',
        slug: `db-integration-approved-${Date.now()}`,
        publicId: `AVR-${nextSequence.id.toString().padStart(15, '0')}`,
        translations: { en: { title: approvedImport.originalTitle } },
        source: approvedImport.source,
        sourceProductId: approvedImport.sourceProductId,
        sourceUrl: approvedImport.sourceUrl,
        salePriceUzs: '1',
        importedFromId: approvedImport.id,
      },
      select: { id: true },
    });
    const changed = await tx.importedProduct.updateMany({
      where: { id: approvedImport.id, status: 'PENDING_REVIEW' },
      data: { status: 'APPROVED', reviewedAt: new Date() },
    });
    assert.equal(changed.count, 1);
    await tx.auditLog.create({
      data: { action: 'PRODUCT_IMPORT_APPROVED', resource: 'ImportedProduct', resourceId: approvedImport.id, meta: { productId: approvedProduct.id } },
    });
    auditResourceIds.push(approvedImport.id);
    return approvedProduct;
  });
  const persistedApproval = await prisma.importedProduct.findUnique({
    where: { id: approvedImport.id },
    include: { product: { select: { id: true, sourceProductId: true } } },
  });
  assert.equal(persistedApproval?.status, 'APPROVED');
  assert.equal(persistedApproval?.product?.id, approval.id);

  const rejectedImport = await createImport('reject');
  assert.equal(await reviewImport(rejectedImport.id, 'REJECTED', 'Invalid source listing'), true);
  const persistedRejection = await prisma.importedProduct.findUnique({
    where: { id: rejectedImport.id },
    select: { status: true, rejectionReason: true, reviewedAt: true },
  });
  assert.equal(persistedRejection?.status, 'REJECTED');
  assert.equal(persistedRejection?.rejectionReason, 'Invalid source listing');
  assert.ok(persistedRejection?.reviewedAt);

  const contestedImport = await createImport('concurrent-review');
  const concurrentResults = await Promise.all([
    reviewImport(contestedImport.id, 'APPROVED'),
    reviewImport(contestedImport.id, 'REJECTED', 'Concurrent rejection'),
  ]);
  assert.equal(concurrentResults.filter(Boolean).length, 1, 'only one concurrent import review may win');
  const persistedContest = await prisma.importedProduct.findUnique({ where: { id: contestedImport.id }, select: { status: true } });
  assert.ok(['APPROVED', 'REJECTED'].includes(persistedContest?.status));

  const fittingAsset = await prisma.product3DAsset.create({
    data: {
      productId: migrated.id,
      fileKey: `db-integration/private/${Date.now()}.glb`,
      fileHash: 'db-integration-glb-sha256',
      fileSize: 1024,
      garmentLayer: 'BASE_TOP',
      validationSummary: 'GLB structure and bounds accepted',
      validationDetails: { format: 'glb', approvedForReview: true },
    },
    select: { id: true, status: true },
  });
  fittingRoomAssetId = fittingAsset.id;
  assert.equal(fittingAsset.status, 'NEEDS_REVIEW');
  const reviewedAsset = await prisma.$transaction(async (tx) => {
    const updated = await tx.product3DAsset.update({
      where: { id: fittingAsset.id },
      data: { status: 'APPROVED', approvedAt: new Date(), reviewedById: 'db-integration-reviewer' },
      select: { status: true, approvedAt: true, validationDetails: true },
    });
    await tx.auditLog.create({
      data: { action: 'PRODUCT_3D_ASSET_APPROVED', resource: 'Product3DAsset', resourceId: fittingAsset.id },
    });
    auditResourceIds.push(fittingAsset.id);
    return updated;
  });
  assert.equal(reviewedAsset.status, 'APPROVED');
  assert.ok(reviewedAsset.approvedAt);
  assert.deepEqual(reviewedAsset.validationDetails, { format: 'glb', approvedForReview: true });

  console.log('PASS: PostgreSQL verifies the article migration, legacy lookup, sequential allocation, composition/care save-reload, persisted import details, approve/reject audit transactions and race guard, and GLB asset review persistence.');
} finally {
  if (createdId) {
    await prisma.commerceProduct.delete({ where: { id: createdId } });
  }
  if (fittingRoomAssetId) {
    await prisma.product3DAsset.deleteMany({ where: { id: fittingRoomAssetId } });
  }
  if (importedIds.length > 0) {
    await prisma.commerceProduct.deleteMany({ where: { importedFromId: { in: importedIds } } });
    await prisma.importedProduct.deleteMany({ where: { id: { in: importedIds } } });
    if (auditResourceIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { resourceId: { in: auditResourceIds } } });
    }
  }
  await prisma.$disconnect();
}
