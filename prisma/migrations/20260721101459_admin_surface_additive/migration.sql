-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN "revokedReason" TEXT;

-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" DATETIME,
    "lastActiveAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "admin_refresh_tokens" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "adminUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "rotatedFrom" TEXT,
    "revokedAt" DATETIME,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "admin_refresh_tokens_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "admin_audit_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "adminUserId" TEXT NOT NULL,
    "adminNameSnapshot" TEXT NOT NULL,
    "adminRoleSnapshot" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "targetBusinessId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "businessId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "costKoboEstimate" INTEGER,
    "meta" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "otp_request_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phoneMasked" TEXT NOT NULL,
    "businessId" TEXT,
    "outcome" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "otp_test_codes" (
    "phone" TEXT NOT NULL PRIMARY KEY,
    "codePlain" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "webhook_event_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "reference" TEXT,
    "outcome" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- AlterTable (hand-additive: plain ADD COLUMN in place of Prisma's SQLite table
-- rewrite, so the live Business table is never dropped/recreated. Semantically
-- identical to the schema; verified drift-free via `prisma migrate diff`.)
ALTER TABLE "Business" ADD COLUMN "isTest" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Business" ADD COLUMN "enterpriseBands" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Business" ADD COLUMN "suspendedAt" DATETIME;

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "admin_refresh_tokens_tokenHash_key" ON "admin_refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "admin_refresh_tokens_adminUserId_idx" ON "admin_refresh_tokens"("adminUserId");

-- CreateIndex
CREATE INDEX "admin_audit_log_createdAt_idx" ON "admin_audit_log"("createdAt");

-- CreateIndex
CREATE INDEX "admin_audit_log_adminUserId_createdAt_idx" ON "admin_audit_log"("adminUserId", "createdAt");

-- CreateIndex
CREATE INDEX "admin_audit_log_actionType_createdAt_idx" ON "admin_audit_log"("actionType", "createdAt");

-- CreateIndex
CREATE INDEX "admin_audit_log_targetBusinessId_createdAt_idx" ON "admin_audit_log"("targetBusinessId", "createdAt");

-- CreateIndex
CREATE INDEX "usage_events_businessId_createdAt_idx" ON "usage_events"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "usage_events_type_createdAt_idx" ON "usage_events"("type", "createdAt");

-- CreateIndex
CREATE INDEX "otp_request_log_createdAt_idx" ON "otp_request_log"("createdAt");

-- CreateIndex
CREATE INDEX "otp_request_log_outcome_createdAt_idx" ON "otp_request_log"("outcome", "createdAt");

-- CreateIndex
CREATE INDEX "webhook_event_log_source_createdAt_idx" ON "webhook_event_log"("source", "createdAt");

-- CreateIndex
CREATE INDEX "webhook_event_log_outcome_createdAt_idx" ON "webhook_event_log"("outcome", "createdAt");
