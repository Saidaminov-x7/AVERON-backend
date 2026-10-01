ALTER TABLE "User" ADD COLUMN "telegramId" TEXT;

CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");
