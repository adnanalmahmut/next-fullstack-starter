import { describe, expect, it } from "vitest";

import { AUDIT_ACTION } from "./audit-action";
import {
  type StoredAuditRecord,
  toAuditRecordDto,
  toAuditRecordDtos,
} from "./audit-record";

function stored(overrides: Partial<StoredAuditRecord> = {}): StoredAuditRecord {
  return {
    id: "record-1",
    occurredAt: new Date("2026-08-01T10:20:30.000Z"),
    action: AUDIT_ACTION.USER_ROLE_SET,
    actorUserId: "actor-1",
    targetUserId: "target-1",
    requestId: "01JXYZREQUESTID000000000",
    metadata: { role: "admin" },
    ...overrides,
  };
}

describe("toAuditRecordDto", () => {
  it("exposes only the reader fields", () => {
    expect(Object.keys(toAuditRecordDto(stored()) ?? {}).sort()).toEqual([
      "action",
      "actorUserId",
      "id",
      "metadata",
      "occurredAt",
      "requestId",
      "targetUserId",
    ]);
  });

  it("never exposes the acting session identifier", () => {
    const dto = toAuditRecordDto(stored());

    expect(JSON.stringify(dto)).not.toContain("actorSessionId");
    expect(dto).not.toHaveProperty("actorSessionId");
  });

  it("serializes the timestamp as an ISO instant", () => {
    expect(toAuditRecordDto(stored())?.occurredAt).toBe(
      "2026-08-01T10:20:30.000Z",
    );
  });

  it("keeps an absent request id absent", () => {
    expect(toAuditRecordDto(stored({ requestId: null }))?.requestId).toBeNull();
  });

  it("drops metadata that is not allowlisted", () => {
    expect(
      toAuditRecordDto(stored({ metadata: { email: "person@example.test" } }))
        ?.metadata,
    ).toBeNull();
    expect(toAuditRecordDto(stored({ metadata: null }))?.metadata).toBeNull();
  });

  it("returns null for an unrecognized action", () => {
    expect(
      toAuditRecordDto(stored({ action: "identity.user.deleted" })),
    ).toBeNull();
    expect(toAuditRecordDto(stored({ action: "" }))).toBeNull();
  });
});

describe("toAuditRecordDtos", () => {
  it("maps every readable record", () => {
    const records = toAuditRecordDtos([
      stored({ id: "a" }),
      stored({
        id: "b",
        action: AUDIT_ACTION.SESSION_REVOKED,
        metadata: { scope: "all" },
      }),
    ]);

    expect(records.map((record) => record.id)).toEqual(["a", "b"]);
    expect(records[1].metadata).toEqual({ scope: "all" });
  });

  it("drops a record that cannot be presented safely", () => {
    const records = toAuditRecordDtos([
      stored({ id: "a" }),
      stored({ id: "b", action: "identity.user.deleted" }),
    ]);

    expect(records.map((record) => record.id)).toEqual(["a"]);
  });

  it("returns an empty list for no records", () => {
    expect(toAuditRecordDtos([])).toEqual([]);
  });
});
