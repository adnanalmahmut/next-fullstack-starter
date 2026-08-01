-- CreateEnum
CREATE TYPE "outbox_dead_letter_code" AS ENUM ('unknown-job', 'unsupported-version', 'invalid-payload', 'payload-too-large', 'publish-attempts-exhausted');

-- CreateTable
CREATE TABLE "outbox_message" (
    "id" TEXT NOT NULL,
    "jobName" VARCHAR(64) NOT NULL,
    "jobVersion" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "correlationId" VARCHAR(128) NOT NULL,
    "causationId" VARCHAR(128),
    "traceparent" VARCHAR(64),
    "tracestate" VARCHAR(512),
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedBy" VARCHAR(64),
    "lockedUntil" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "deadLetteredAt" TIMESTAMP(3),
    "deadLetterCode" "outbox_dead_letter_code",
    "lastErrorCode" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbox_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_execution_receipt" (
    "executionKey" VARCHAR(64) NOT NULL,
    "jobName" VARCHAR(64) NOT NULL,
    "jobVersion" INTEGER NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_execution_receipt_pkey" PRIMARY KEY ("executionKey")
);

-- CreateIndex
CREATE INDEX "outbox_message_dispatchable_idx" ON "outbox_message"("publishedAt", "deadLetteredAt", "availableAt", "createdAt", "id");

-- CreateIndex
CREATE INDEX "outbox_message_locked_until_idx" ON "outbox_message"("lockedUntil");

-- CreateIndex
CREATE INDEX "outbox_message_dead_lettered_at_idx" ON "outbox_message"("deadLetteredAt");

-- CreateIndex
CREATE INDEX "outbox_message_job_idx" ON "outbox_message"("jobName", "jobVersion");

-- CreateIndex
CREATE INDEX "job_execution_receipt_job_idx" ON "job_execution_receipt"("jobName", "jobVersion", "completedAt");
