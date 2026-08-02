-- CreateEnum
CREATE TYPE "audit_actor_type" AS ENUM ('user', 'system');

-- CreateEnum
CREATE TYPE "audit_result" AS ENUM ('succeeded', 'failed', 'denied');

-- CreateTable
CREATE TABLE "audit_record" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" "audit_actor_type" NOT NULL,
    "actorId" VARCHAR(255) NOT NULL,
    "actorSessionId" VARCHAR(255),
    "action" VARCHAR(96) NOT NULL,
    "resourceType" VARCHAR(64) NOT NULL,
    "resourceId" VARCHAR(255) NOT NULL,
    "result" "audit_result" NOT NULL,
    "requestId" VARCHAR(36),
    "metadata" JSONB,

    CONSTRAINT "audit_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_record_occurredAt_id_idx" ON "audit_record"("occurredAt", "id");

-- CreateIndex
CREATE INDEX "audit_record_actorType_actorId_occurredAt_idx" ON "audit_record"("actorType", "actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_record_resourceType_resourceId_occurredAt_idx" ON "audit_record"("resourceType", "resourceId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_record_action_occurredAt_idx" ON "audit_record"("action", "occurredAt");

-- The application validates all of this before it writes. These constraints are
-- the second, independent layer: they hold for a row that arrives through psql,
-- a data fix, or a future code path that forgets, and they are what makes the
-- shape of an audit record a property of the database rather than a convention.

-- AddConstraint
ALTER TABLE "audit_record"
    ADD CONSTRAINT "audit_record_actor_id_bounded"
    CHECK (char_length("actorId") BETWEEN 1 AND 255);

-- AddConstraint
ALTER TABLE "audit_record"
    ADD CONSTRAINT "audit_record_actor_session_id_bounded"
    CHECK ("actorSessionId" IS NULL OR char_length("actorSessionId") BETWEEN 1 AND 255);

-- AddConstraint
ALTER TABLE "audit_record"
    ADD CONSTRAINT "audit_record_resource_id_bounded"
    CHECK (char_length("resourceId") BETWEEN 1 AND 255);

-- AddConstraint
-- `<owner>.<resource>.<action>`, lowercase ASCII, hyphens allowed inside a part.
ALTER TABLE "audit_record"
    ADD CONSTRAINT "audit_record_action_pattern"
    CHECK (
        char_length("action") BETWEEN 1 AND 96
        AND "action" ~ '^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$'
    );

-- AddConstraint
-- `<owner>.<resource>`.
ALTER TABLE "audit_record"
    ADD CONSTRAINT "audit_record_resource_type_pattern"
    CHECK (
        char_length("resourceType") BETWEEN 1 AND 64
        AND "resourceType" ~ '^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$'
    );

-- AddConstraint
-- Canonical UUID form when present. Case-insensitive, because the request-id
-- header validator that produced the copied values accepted either case.
ALTER TABLE "audit_record"
    ADD CONSTRAINT "audit_record_request_id_canonical"
    CHECK (
        "requestId" IS NULL
        OR "requestId" ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    );

-- AddConstraint
-- The same 4096-byte ceiling the platform applies before writing.
ALTER TABLE "audit_record"
    ADD CONSTRAINT "audit_record_metadata_bounded"
    CHECK ("metadata" IS NULL OR octet_length("metadata"::text) <= 4096);

-- AddConstraint
-- A user action is always traceable to one sign-in; a system action never is,
-- because there was none. The application models this as a union; the database
-- refuses the two impossible rows.
ALTER TABLE "audit_record"
    ADD CONSTRAINT "audit_record_actor_session_presence"
    CHECK (
        ("actorType" = 'user' AND "actorSessionId" IS NOT NULL)
        OR ("actorType" = 'system' AND "actorSessionId" IS NULL)
    );

-- Backfill from the legacy authorization audit trail.
--
-- Every existing row is copied once, here, so the new admin reader shows the
-- complete history rather than only what happened after this deployment. The
-- legacy table is not touched: no row is updated, and none is deleted. It stays
-- as the original of what was copied.
--
-- The mapping is total for the two actions that table can hold. Both were
-- performed by a signed-in administrator, so the actor is `user` and the session
-- identifier carries over. Both were written only after the change had already
-- succeeded, so the result is `succeeded`. Both recorded a target user, so the
-- resource is `identity.user` and `targetUserId` becomes `resourceId` — that is
-- true of `identity.session.revoked` as well, whose target was always a user.
-- The action names are unchanged, and the identifiers are preserved, so a record
-- referenced by id before this migration is the same record after it.
INSERT INTO "audit_record" (
    "id",
    "occurredAt",
    "actorType",
    "actorId",
    "actorSessionId",
    "action",
    "resourceType",
    "resourceId",
    "result",
    "requestId",
    "metadata"
)
SELECT
    "legacy"."id",
    "legacy"."occurredAt",
    'user'::"audit_actor_type",
    "legacy"."actorUserId",
    "legacy"."actorSessionId",
    "legacy"."action"::text,
    'identity.user',
    "legacy"."targetUserId",
    'succeeded'::"audit_result",
    "legacy"."requestId",
    "legacy"."metadata"
FROM "authorization_audit_record" AS "legacy";
