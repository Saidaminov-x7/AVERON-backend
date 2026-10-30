-- Requires a PostgreSQL distribution with the pgvector extension installed.
-- Railway's standard PostgreSQL image does not include pgvector; provision a
-- pgvector-capable database before deploying this migration.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "ProductImageEmbedding"
    ADD COLUMN "embeddingVector" vector(1024);

CREATE INDEX "ProductImageEmbedding_vector_cosine_idx"
    ON "ProductImageEmbedding"
    USING hnsw ("embeddingVector" vector_cosine_ops)
    WHERE "status" = 'INDEXED' AND "embeddingVector" IS NOT NULL;
