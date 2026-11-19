-- Persisted card operations, freeze provenance, event ordering, webhook normalisation and
-- admin login hardening. See docs/DECISIONS.md (D10-D13).

-- CreateEnum
CREATE TYPE "CardFreezeSource" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "OperationStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CancellationStatus" AS ENUM ('PENDING', 'SWEEPING', 'SWEPT', 'COMPLETED');

-- AlterTable
ALTER TABLE "Card" ADD COLUMN     "balanceAsOf" TIMESTAMP(3),
ADD COLUMN     "frozenBy" "CardFreezeSource",
ADD COLUMN     "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastError" TEXT;

-- AlterTable
ALTER TABLE "WebhookEvent" ADD COLUMN     "normalized" JSONB;

-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastTotpStep" INTEGER,
ADD COLUMN     "lockedUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CardIssuance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "spendingLimitFils" INTEGER,
    "status" "OperationStatus" NOT NULL DEFAULT 'PENDING',
    "cardId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardIssuance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardFunding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "amountFils" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "OperationStatus" NOT NULL DEFAULT 'PENDING',
    "providerRef" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardFunding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardCancellation" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestedByType" "ActorType" NOT NULL,
    "requestedById" TEXT,
    "reason" TEXT,
    "status" "CancellationStatus" NOT NULL DEFAULT 'PENDING',
    "sweepFils" INTEGER,
    "unloadRef" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardCancellation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CardIssuance_idempotencyKey_key" ON "CardIssuance"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "CardIssuance_cardId_key" ON "CardIssuance"("cardId");

-- CreateIndex
CREATE INDEX "CardIssuance_userId_status_idx" ON "CardIssuance"("userId", "status");

-- CreateIndex
CREATE INDEX "CardIssuance_status_updatedAt_idx" ON "CardIssuance"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CardFunding_idempotencyKey_key" ON "CardFunding"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CardFunding_cardId_status_idx" ON "CardFunding"("cardId", "status");

-- CreateIndex
CREATE INDEX "CardFunding_status_updatedAt_idx" ON "CardFunding"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CardCancellation_cardId_key" ON "CardCancellation"("cardId");

-- CreateIndex
CREATE INDEX "CardCancellation_status_updatedAt_idx" ON "CardCancellation"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "Purchase_type_status_createdAt_idx" ON "Purchase"("type", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Refund_status_updatedAt_idx" ON "Refund"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_processedAt_receivedAt_idx" ON "WebhookEvent"("processedAt", "receivedAt");

-- AddForeignKey
ALTER TABLE "CardFunding" ADD CONSTRAINT "CardFunding_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardCancellation" ADD CONSTRAINT "CardCancellation_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
