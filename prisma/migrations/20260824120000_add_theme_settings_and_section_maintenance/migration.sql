-- Add section-level maintenance visibility and persisted design tokens.
ALTER TABLE "PageSection"
ADD COLUMN "isUnderMaintenance" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ThemeSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "primaryColor" TEXT NOT NULL DEFAULT '#14b8a6',
    "secondaryColor" TEXT NOT NULL DEFAULT '#0f766e',
    "backgroundColor" TEXT NOT NULL DEFAULT '#f9fafb',
    "textColor" TEXT NOT NULL DEFAULT '#111827',
    "borderRadius" TEXT NOT NULL DEFAULT '0.75rem',
    "fontFamily" TEXT NOT NULL DEFAULT 'Inter, sans-serif',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "ThemeSettings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ThemeSettings_updatedById_idx" ON "ThemeSettings"("updatedById");

ALTER TABLE "ThemeSettings"
ADD CONSTRAINT "ThemeSettings_updatedById_fkey"
FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
