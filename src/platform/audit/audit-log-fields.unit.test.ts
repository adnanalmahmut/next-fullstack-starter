import { describe, expect, it } from "vitest";

import { AUDIT_LOG_FIELD_NAMES, toAuditLogFields } from "./audit-log-fields";

describe("toAuditLogFields", () => {
  it("declares the whole allowlist in one list", () => {
    expect([...AUDIT_LOG_FIELD_NAMES]).toEqual([
      "action",
      "actorType",
      "actorId",
      "resourceType",
      "resourceId",
      "result",
      "requestId",
      "errorCode",
    ]);
  });

  it("keeps every allowlisted field", () => {
    expect(
      toAuditLogFields({
        action: "identity.user.role-set",
        actorType: "user",
        actorId: "actor-1",
        resourceType: "identity.user",
        resourceId: "target-1",
        result: "succeeded",
        requestId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        errorCode: "INTERNAL_ERROR",
      }),
    ).toEqual({
      action: "identity.user.role-set",
      actorType: "user",
      actorId: "actor-1",
      resourceType: "identity.user",
      resourceId: "target-1",
      result: "succeeded",
      requestId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      errorCode: "INTERNAL_ERROR",
    });
  });

  it("drops anything outside the allowlist", () => {
    const fields = toAuditLogFields({
      action: "identity.user.role-set",
      metadata: { role: "admin" },
      actorSessionId: "session-1",
      email: "a@b.test",
      error: new Error("boom"),
      stack: "at ...",
    } as never);

    expect(fields).toEqual({ action: "identity.user.role-set" });
    expect(JSON.stringify(fields)).not.toContain("session-1");
    expect(JSON.stringify(fields)).not.toContain("a@b.test");
  });

  it("omits an absent value instead of claiming null", () => {
    expect(toAuditLogFields({ action: "x.y.z", requestId: null })).toEqual({
      action: "x.y.z",
    });
    expect(toAuditLogFields({})).toEqual({});
  });
});
