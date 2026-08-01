-- CreateEnum
CREATE TYPE "authorization_audit_action" AS ENUM ('identity.user.role-set', 'identity.session.revoked');

-- CreateTable
CREATE TABLE "authorization_audit_record" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" TEXT NOT NULL,
    "actorSessionId" TEXT NOT NULL,
    "action" "authorization_audit_action" NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "requestId" TEXT,
    "metadata" JSONB,

    CONSTRAINT "authorization_audit_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "authorization_audit_record_occurredAt_idx" ON "authorization_audit_record"("occurredAt");

-- CreateIndex
CREATE INDEX "authorization_audit_record_actorUserId_occurredAt_idx" ON "authorization_audit_record"("actorUserId", "occurredAt");

-- CreateIndex
CREATE INDEX "authorization_audit_record_targetUserId_occurredAt_idx" ON "authorization_audit_record"("targetUserId", "occurredAt");
