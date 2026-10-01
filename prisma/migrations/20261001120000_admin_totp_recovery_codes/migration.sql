ALTER TABLE "User"
  ADD COLUMN "adminTotpSecret" TEXT,
  ADD COLUMN "adminTotpEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "adminTotpLastCounter" BIGINT;

CREATE TABLE "AdminRecoveryCode" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AdminRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminRecoveryCode_codeHash_key"
  ON "AdminRecoveryCode"("codeHash");

CREATE INDEX "AdminRecoveryCode_userId_usedAt_idx"
  ON "AdminRecoveryCode"("userId", "usedAt");

ALTER TABLE "AdminRecoveryCode"
  ADD CONSTRAINT "AdminRecoveryCode_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
