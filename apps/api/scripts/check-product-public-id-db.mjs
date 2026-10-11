import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const legacyId = 'a42h-nbsq-o1fp-awaz';
let createdId;

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
      source: 'MANUAL',
      sourceProductId: `db-integration-${Date.now()}`,
      salePriceUzs: '1',
    },
    select: { id: true, publicId: true, legacyPublicId: true },
  });
  createdId = created.id;

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

  console.log('PASS: additive migration preserves old IDs, assigns AVR-000000000000001, and allocates AVR-000000000000002 next.');
} finally {
  if (createdId) {
    await prisma.commerceProduct.delete({ where: { id: createdId } });
  }
  await prisma.$disconnect();
}
