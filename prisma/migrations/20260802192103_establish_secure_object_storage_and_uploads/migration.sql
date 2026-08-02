-- CreateEnum
CREATE TYPE "storage_object_status" AS ENUM ('pending', 'ready', 'quarantined', 'rejected', 'expired');

-- CreateEnum
CREATE TYPE "storage_inspection_result" AS ENUM ('not-configured', 'clean', 'quarantined');

-- CreateEnum
CREATE TYPE "storage_upload_intent_status" AS ENUM ('pending', 'finalizing', 'finalized', 'quarantined', 'rejected', 'expired');

-- CreateTable
CREATE TABLE "storage_object" (
    "id" TEXT NOT NULL,
    "status" "storage_object_status" NOT NULL DEFAULT 'pending',
    "objectKey" VARCHAR(512) NOT NULL,
    "contentType" VARCHAR(128),
    "sizeBytes" BIGINT,
    "checksumSha256" VARCHAR(64),
    "etag" VARCHAR(128),
    "inspectionResult" "storage_inspection_result",
    "inspectionReason" VARCHAR(64),
    "readyAt" TIMESTAMP(3),
    "quarantinedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_object_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_upload_intent" (
    "id" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "status" "storage_upload_intent_status" NOT NULL DEFAULT 'pending',
    "stagingKey" VARCHAR(512) NOT NULL,
    "finalizeTokenHash" VARCHAR(64) NOT NULL,
    "policyName" VARCHAR(64) NOT NULL,
    "declaredExtension" VARCHAR(16) NOT NULL,
    "expectedContentType" VARCHAR(128) NOT NULL,
    "expectedSizeBytes" BIGINT NOT NULL,
    "expectedChecksumSha256" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "finalizeLeaseTokenHash" VARCHAR(64),
    "finalizeLeaseExpiresAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "failureReason" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "storage_upload_intent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "storage_object_objectKey_key" ON "storage_object"("objectKey");

-- CreateIndex
CREATE INDEX "storage_object_status_createdAt_idx" ON "storage_object"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "storage_upload_intent_objectId_key" ON "storage_upload_intent"("objectId");

-- CreateIndex
CREATE UNIQUE INDEX "storage_upload_intent_stagingKey_key" ON "storage_upload_intent"("stagingKey");

-- CreateIndex
CREATE INDEX "storage_upload_intent_status_expiresAt_idx" ON "storage_upload_intent"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "storage_upload_intent_status_finalizeLeaseExpiresAt_idx" ON "storage_upload_intent"("status", "finalizeLeaseExpiresAt");

-- AddForeignKey
ALTER TABLE "storage_upload_intent" ADD CONSTRAINT "storage_upload_intent_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "storage_object"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The application validates all of this before it writes. These constraints are
-- the second, independent layer: they hold for a row that arrives through psql,
-- a data fix, or a future code path that forgets. Two of them are worth naming
-- as security properties rather than as hygiene — a storage key can never
-- contain a traversal sequence, and a `ready` object can never exist without the
-- verified metadata that made it ready.

-- AddConstraint
-- A key is server-generated, so this is a shape the application already
-- guarantees. It is restated here because a key is what a provider request is
-- built from: `..` or an empty segment in one would be a path the application
-- did not intend to address.
ALTER TABLE "storage_object"
    ADD CONSTRAINT "storage_object_key_pattern"
    CHECK (
        char_length("objectKey") BETWEEN 8 AND 512
        AND "objectKey" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9_-]$'
        AND "objectKey" NOT LIKE '%..%'
        AND "objectKey" NOT LIKE '%//%'
    );

-- AddConstraint
-- The final and quarantine namespaces are the only places a stored object may
-- live. Staging is not one of them: an object row must never point at a key the
-- client was able to write.
ALTER TABLE "storage_object"
    ADD CONSTRAINT "storage_object_key_namespace"
    CHECK (
        "objectKey" LIKE '%/objects/%'
        OR "objectKey" LIKE '%/quarantine/%'
    );

-- AddConstraint
ALTER TABLE "storage_object"
    ADD CONSTRAINT "storage_object_content_type_pattern"
    CHECK (
        "contentType" IS NULL
        OR (
            char_length("contentType") BETWEEN 3 AND 128
            AND "contentType" ~ '^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$'
        )
    );

-- AddConstraint
ALTER TABLE "storage_object"
    ADD CONSTRAINT "storage_object_size_positive"
    CHECK ("sizeBytes" IS NULL OR "sizeBytes" > 0);

-- AddConstraint
-- Canonical SHA-256: 64 lowercase hexadecimal characters, and only that. One
-- representation means a comparison can never be defeated by case or encoding.
ALTER TABLE "storage_object"
    ADD CONSTRAINT "storage_object_checksum_canonical"
    CHECK ("checksumSha256" IS NULL OR "checksumSha256" ~ '^[0-9a-f]{64}$');

-- AddConstraint
-- Nothing is ready before the bytes were verified, and nothing that was
-- withheld is ready as well. Every column a caller reads from a ready object is
-- required here, so a partially written row cannot be served.
ALTER TABLE "storage_object"
    ADD CONSTRAINT "storage_object_ready_state"
    CHECK (
        "status" <> 'ready'
        OR (
            "contentType" IS NOT NULL
            AND "sizeBytes" IS NOT NULL
            AND "checksumSha256" IS NOT NULL
            AND "readyAt" IS NOT NULL
            AND "quarantinedAt" IS NULL
            AND "inspectionResult" IS NOT NULL
            AND "inspectionResult" <> 'quarantined'
            AND "objectKey" LIKE '%/objects/%'
        )
    );

-- AddConstraint
ALTER TABLE "storage_object"
    ADD CONSTRAINT "storage_object_quarantined_state"
    CHECK (
        "status" <> 'quarantined'
        OR (
            "quarantinedAt" IS NOT NULL
            AND "readyAt" IS NULL
            AND "inspectionResult" = 'quarantined'
            AND "inspectionReason" IS NOT NULL
            AND "objectKey" LIKE '%/quarantine/%'
        )
    );

-- AddConstraint
-- A pending object has not been decided yet, and neither timestamp may claim it
-- has. The same holds for the two ways of never becoming ready.
ALTER TABLE "storage_object"
    ADD CONSTRAINT "storage_object_undecided_state"
    CHECK (
        "status" NOT IN ('pending', 'rejected', 'expired')
        OR ("readyAt" IS NULL AND "quarantinedAt" IS NULL)
    );

-- AddConstraint
ALTER TABLE "storage_upload_intent"
    ADD CONSTRAINT "storage_upload_intent_staging_key_pattern"
    CHECK (
        char_length("stagingKey") BETWEEN 8 AND 512
        AND "stagingKey" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9_-]$'
        AND "stagingKey" NOT LIKE '%..%'
        AND "stagingKey" NOT LIKE '%//%'
        AND "stagingKey" LIKE '%/staging/%'
    );

-- AddConstraint
ALTER TABLE "storage_upload_intent"
    ADD CONSTRAINT "storage_upload_intent_finalize_token_hash_canonical"
    CHECK ("finalizeTokenHash" ~ '^[0-9a-f]{64}$');

-- AddConstraint
ALTER TABLE "storage_upload_intent"
    ADD CONSTRAINT "storage_upload_intent_lease_token_hash_canonical"
    CHECK (
        "finalizeLeaseTokenHash" IS NULL
        OR "finalizeLeaseTokenHash" ~ '^[0-9a-f]{64}$'
    );

-- AddConstraint
-- `<owner>.<purpose>`, lowercase ASCII. A policy name is server-owned; it is
-- never a value a client supplied.
ALTER TABLE "storage_upload_intent"
    ADD CONSTRAINT "storage_upload_intent_policy_name_pattern"
    CHECK (
        char_length("policyName") BETWEEN 3 AND 64
        AND "policyName" ~ '^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$'
    );

-- AddConstraint
ALTER TABLE "storage_upload_intent"
    ADD CONSTRAINT "storage_upload_intent_extension_pattern"
    CHECK ("declaredExtension" ~ '^[a-z0-9]{1,16}$');

-- AddConstraint
ALTER TABLE "storage_upload_intent"
    ADD CONSTRAINT "storage_upload_intent_content_type_pattern"
    CHECK (
        char_length("expectedContentType") BETWEEN 3 AND 128
        AND "expectedContentType" ~ '^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$'
    );

-- AddConstraint
ALTER TABLE "storage_upload_intent"
    ADD CONSTRAINT "storage_upload_intent_expected_size_positive"
    CHECK ("expectedSizeBytes" > 0);

-- AddConstraint
ALTER TABLE "storage_upload_intent"
    ADD CONSTRAINT "storage_upload_intent_expected_checksum_canonical"
    CHECK ("expectedChecksumSha256" ~ '^[0-9a-f]{64}$');

-- AddConstraint
-- An intent that expires at or before it was created is one no client could ever
-- have used.
ALTER TABLE "storage_upload_intent"
    ADD CONSTRAINT "storage_upload_intent_expiry_after_creation"
    CHECK ("expiresAt" > "createdAt");

-- AddConstraint
ALTER TABLE "storage_upload_intent"
    ADD CONSTRAINT "storage_upload_intent_version_positive"
    CHECK ("version" > 0);

-- AddConstraint
-- A lease is a pair. Half of one would be a claim nobody can prove they hold, or
-- a hold with no end.
ALTER TABLE "storage_upload_intent"
    ADD CONSTRAINT "storage_upload_intent_lease_pair"
    CHECK (
        ("finalizeLeaseTokenHash" IS NULL) = ("finalizeLeaseExpiresAt" IS NULL)
    );

-- AddConstraint
ALTER TABLE "storage_upload_intent"
    ADD CONSTRAINT "storage_upload_intent_finalizing_state"
    CHECK (
        "status" <> 'finalizing'
        OR (
            "finalizeLeaseTokenHash" IS NOT NULL
            AND "finalizeLeaseExpiresAt" IS NOT NULL
            AND "finalizedAt" IS NULL
        )
    );

-- AddConstraint
-- A finalized intent has released its lease. Leaving one behind would let a
-- cleanup pass mistake a completed upload for an abandoned attempt.
ALTER TABLE "storage_upload_intent"
    ADD CONSTRAINT "storage_upload_intent_finalized_state"
    CHECK (
        "status" <> 'finalized'
        OR (
            "finalizedAt" IS NOT NULL
            AND "finalizeLeaseTokenHash" IS NULL
            AND "finalizeLeaseExpiresAt" IS NULL
        )
    );

-- AddConstraint
ALTER TABLE "storage_upload_intent"
    ADD CONSTRAINT "storage_upload_intent_unfinalized_state"
    CHECK (
        "status" NOT IN ('pending', 'quarantined', 'rejected', 'expired')
        OR (
            "finalizedAt" IS NULL
            AND "finalizeLeaseTokenHash" IS NULL
            AND "finalizeLeaseExpiresAt" IS NULL
        )
    );
