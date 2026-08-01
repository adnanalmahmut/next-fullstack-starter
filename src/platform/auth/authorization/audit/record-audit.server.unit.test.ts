import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StructuredLogger } from "@/platform/observability/create-logger.server";

import { AUDIT_ACTION } from "./audit-action";
import type { AuthorizationAuditWrite } from "./audit-record";

const appendAuthorizationAuditRecord = vi.fn();

vi.mock("./audit-repository.server", () => ({
  appendAuthorizationAuditRecord: (record: AuthorizationAuditWrite) =>
    appendAuthorizationAuditRecord(record),
}));

const { recordAuthorizationAudit } = await import("./record-audit.server");

type LogCall = {
  level: "info" | "error";
  record: Record<string, unknown>;
  event: unknown;
};

function createRecordingLogger(): {
  logger: StructuredLogger;
  calls: LogCall[];
} {
  const calls: LogCall[] = [];

  function capture(level: LogCall["level"]) {
    return (record: unknown, event: unknown) => {
      calls.push({
        level,
        record: record as Record<string, unknown>,
        event,
      });
    };
  }

  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: capture("info"),
    warn: vi.fn(),
    error: capture("error"),
    fatal: vi.fn(),
    child: () => logger,
  } as unknown as StructuredLogger;

  return { logger, calls };
}

const write: AuthorizationAuditWrite = {
  actorUserId: "actor-1",
  actorSessionId: "session-1",
  action: AUDIT_ACTION.USER_ROLE_SET,
  targetUserId: "target-1",
  requestId: "01JXYZREQUESTID000000000",
  metadata: { role: "admin" },
};

beforeEach(() => {
  appendAuthorizationAuditRecord.mockReset();
});

describe("recordAuthorizationAudit", () => {
  it("appends the record and reports success", async () => {
    appendAuthorizationAuditRecord.mockResolvedValue(undefined);

    const { logger, calls } = createRecordingLogger();

    expect(await recordAuthorizationAudit(write, logger)).toBe(true);
    expect(appendAuthorizationAuditRecord).toHaveBeenCalledWith(write);
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("info");
    expect(calls[0].event).toBe("authorization.admin.operation_completed");
  });

  it("does not turn a storage failure into a caller-visible failure", async () => {
    appendAuthorizationAuditRecord.mockRejectedValue(
      new Error("relation does not exist"),
    );

    const { logger, calls } = createRecordingLogger();

    await expect(recordAuthorizationAudit(write, logger)).resolves.toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("error");
    expect(calls[0].event).toBe("authorization.audit.write_failed");
  });

  it("records the identifiers needed to reconcile a lost record", async () => {
    appendAuthorizationAuditRecord.mockRejectedValue(new Error("timeout"));

    const { logger, calls } = createRecordingLogger();

    await recordAuthorizationAudit(write, logger);

    expect(calls[0].record).toMatchObject({
      action: AUDIT_ACTION.USER_ROLE_SET,
      actorUserId: "actor-1",
      targetUserId: "target-1",
      requestId: "01JXYZREQUESTID000000000",
      errorCode: "INTERNAL_ERROR",
    });
  });

  it("logs no raw error, metadata, or session identifier", async () => {
    appendAuthorizationAuditRecord.mockRejectedValue(
      new Error("password=hunter2 at /srv/app/prisma.ts"),
    );

    const { logger, calls } = createRecordingLogger();

    await recordAuthorizationAudit(write, logger);

    const serialized = JSON.stringify(calls[0].record);

    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("/srv/app");
    expect(serialized).not.toContain("session-1");
    expect(calls[0].record).not.toHaveProperty("metadata");
    expect(calls[0].record).not.toHaveProperty("actorSessionId");
    expect(calls[0].record).not.toHaveProperty("stack");
  });

  it("logs no session identifier on success either", async () => {
    appendAuthorizationAuditRecord.mockResolvedValue(undefined);

    const { logger, calls } = createRecordingLogger();

    await recordAuthorizationAudit(write, logger);

    expect(JSON.stringify(calls[0].record)).not.toContain("session-1");
  });
});
