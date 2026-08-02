import { beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";

import type { StructuredLogger } from "@/platform/observability/create-logger.server";

import { defineAuditAction } from "./audit-action";
import { userAuditActor } from "./audit-actor";
import { AUDIT_RESULT } from "./audit-result";
import { AUDIT_LOG_EVENT } from "./log-event";

const insertAuditRecord = vi.hoisted(() => vi.fn());

vi.mock("./audit-repository.server", () => ({ insertAuditRecord }));

const { recordAuditPostCommit } =
  await import("./record-audit-post-commit.server");

const roleSet = defineAuditAction({
  name: "identity.user.role-set",
  resourceType: "identity.user",
  metadataSchema: z.object({ role: z.enum(["user", "admin"]) }).strict(),
});

const actor = userAuditActor("actor-1", "session-1");
const requestId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function createLogger() {
  const error = vi.fn();
  const info = vi.fn();

  return {
    logger: { error, info } as unknown as StructuredLogger,
    error,
    info,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    actor,
    resourceId: "target-1",
    result: AUDIT_RESULT.SUCCEEDED,
    requestId,
    metadata: { role: "admin" } as const,
    ...overrides,
  };
}

describe("recordAuditPostCommit", () => {
  beforeEach(() => {
    insertAuditRecord.mockReset();
    insertAuditRecord.mockResolvedValue("record-1");
  });

  it("writes the record and answers true", async () => {
    const { logger, error } = createLogger();

    await expect(recordAuditPostCommit(roleSet, input(), logger)).resolves.toBe(
      true,
    );

    expect(insertAuditRecord).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it("answers false rather than throwing when storage fails", async () => {
    insertAuditRecord.mockRejectedValueOnce(new Error("connection lost"));

    const { logger, error } = createLogger();

    // The change it describes has already committed. Throwing here would make a
    // caller either report a completed change as failed or retry it.
    await expect(recordAuditPostCommit(roleSet, input(), logger)).resolves.toBe(
      false,
    );
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("records the failure under a stable event with allowlisted fields", async () => {
    insertAuditRecord.mockRejectedValueOnce(new Error("connection lost"));

    const { logger, error } = createLogger();

    await recordAuditPostCommit(roleSet, input(), logger);

    const [fields, event] = error.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];

    expect(event).toBe(AUDIT_LOG_EVENT.RECORD_WRITE_FAILED);
    expect(fields).toEqual({
      action: "identity.user.role-set",
      actorType: "user",
      actorId: "actor-1",
      resourceType: "identity.user",
      resourceId: "target-1",
      result: "succeeded",
      requestId,
      errorCode: "INTERNAL_ERROR",
    });
  });

  it("never logs the metadata, the session, or the raw error", async () => {
    insertAuditRecord.mockRejectedValueOnce(
      new Error("insert into audit_record failed for user a@b.test"),
    );

    const { logger, error } = createLogger();

    await recordAuditPostCommit(roleSet, input(), logger);

    const fields = error.mock.calls[0]?.[0] as Record<string, unknown>;
    const serialized = JSON.stringify(fields);

    expect(Object.keys(fields)).not.toContain("metadata");
    expect(Object.keys(fields)).not.toContain("actorSessionId");
    expect(serialized).not.toContain("session-1");
    expect(serialized).not.toContain("a@b.test");
    expect(serialized).not.toContain("insert into audit_record");
    // The role is the metadata value; the action name legitimately contains
    // "role-set", so the assertion is on the value rather than the substring.
    expect(Object.values(fields)).not.toContain("admin");
    expect(serialized).not.toContain("stack");
  });

  it("refuses an invalid record before it reaches storage", async () => {
    const { logger, error } = createLogger();

    await expect(
      recordAuditPostCommit(
        roleSet,
        input({ metadata: { role: "superadmin" } }),
        logger,
      ),
    ).resolves.toBe(false);

    expect(insertAuditRecord).not.toHaveBeenCalled();
    expect(error.mock.calls[0]?.[0]).toMatchObject({
      errorCode: "invalid-metadata",
    });
  });

  it("still reports a refusal whose actor is missing", async () => {
    const { logger, error } = createLogger();

    await expect(
      recordAuditPostCommit(
        roleSet,
        input({ actor: undefined } as never),
        logger,
      ),
    ).resolves.toBe(false);

    expect(error.mock.calls[0]?.[0]).toMatchObject({
      errorCode: "invalid-actor",
    });
  });
});
