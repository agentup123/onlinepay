-- Sanctions / PEP screening result on KYC applications.

-- CreateEnum
CREATE TYPE "ScreeningStatus" AS ENUM ('CLEAR', 'POTENTIAL_MATCH', 'ERROR');

-- AlterTable
ALTER TABLE "KycApplication" ADD COLUMN     "screenedAt" TIMESTAMP(3),
ADD COLUMN     "screeningRef" TEXT,
ADD COLUMN     "screeningStatus" "ScreeningStatus",
ADD COLUMN     "screeningSummary" TEXT;

-- CreateIndex
CREATE INDEX "KycApplication_status_screenedAt_idx" ON "KycApplication"("status", "screenedAt");
