import { beforeEach, describe, expect, it, vi } from "vitest";

import { userAuditActor } from "@/platform/audit/index.server";
import type { StructuredLogger } from "@/platform/observability/create-logger.server";

import { AUTHORIZATION_LOG_EVENT } from "../log-event";

import { userRoleSetAudit } from "./identity-audit-actions";

const recordAuditPostCommit = vi.hoisted(() => vi.fn());

vi.mock("@/platform/audit/index.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/audit/index.server")>()),
  recordAuditPostCommit,
}));

const { recordIdentityAudit } = await import("./record-identity-audit.server");

const requestId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function createLogger() {
  const info = vi.fn();
  const error = vi.fn();

  return {
    logger: { info, error } as unknown as StructuredLogger,
    info,
    error,
  };
}

const input = {
  actor: userAuditActor("actor-1", "session-1"),
  resourceId: "target-1",
  result: "succeeded",
  requestId,
  metadata: { role: "admin" },
} as const;

describe("recordIdentityAudit", () => {
  beforeEach(() => {
    recordAuditPostCommit.mockReset();
  });

  it("delegates to the post-commit writer", async () => {
    recordAuditPostCommit.mockResolvedValue(true);

    const { logger } = createLogger();

    await expect(
      recordIdentityAudit(userRoleSetAudit, input, logger),
    ).resolves.toBe(true);

    expect(recordAuditPostCommit).toHaveBeenCalledWith(
      userRoleSetAudit,
      input,
      logger,
    );
  });

  it("reports the completed operation once the record is written", async () => {
    recordAuditPostCommit.mockResolvedValue(true);

    const { logger, info } = createLogger();

    await recordIdentityAudit(userRoleSetAudit, input, logger);

    expect(info).toHaveBeenCalledWith(
      {
        action: "identity.user.role-set",
        actorUserId: "actor-1",
        targetUserId: "target-1",
        requestId,
      },
      AUTHORIZATION_LOG_EVENT.ADMIN_OPERATION_COMPLETED,
    );
  });

  it("does not claim the operation completed when the record was lost", async () => {
    recordAuditPostCommit.mockResolvedValue(false);

    const { logger, info } = createLogger();

    await expect(
      recordIdentityAudit(userRoleSetAudit, input, logger),
    ).resolves.toBe(false);
    expect(info).not.toHaveBeenCalled();
  });

  it("logs no acting session and no metadata", async () => {
    recordAuditPostCommit.mockResolvedValue(true);

    const { logger, info } = createLogger();

    await recordIdentityAudit(userRoleSetAudit, input, logger);

    const fields = info.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(Object.keys(fields).sort()).toEqual([
      "action",
      "actorUserId",
      "requestId",
      "targetUserId",
    ]);
    // "admin" appears in the event name, so the assertion is on the values: the
    // recorded role is metadata and must not be one of them.
    expect(Object.values(fields)).not.toContain("admin");
    expect(JSON.stringify(fields)).not.toContain("session-1");
  });
});
