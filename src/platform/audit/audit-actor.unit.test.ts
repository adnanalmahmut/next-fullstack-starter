import { describe, expect, it } from "vitest";

import {
  AUDIT_ACTOR_TYPE,
  AUDIT_ACTOR_TYPES,
  auditActorSessionId,
  isAuditActor,
  MAX_AUDIT_ACTOR_ID_LENGTH,
  parseAuditActor,
  systemAuditActor,
  userAuditActor,
} from "./audit-actor";

describe("the actor contract", () => {
  it("declares exactly two kinds", () => {
    expect(AUDIT_ACTOR_TYPES).toEqual(["user", "system"]);
  });

  it("accepts a user actor with a session", () => {
    const actor = userAuditActor("user-1", "session-1");

    expect(actor).toEqual({
      type: AUDIT_ACTOR_TYPE.USER,
      id: "user-1",
      sessionId: "session-1",
    });
    expect(isAuditActor(actor)).toBe(true);
  });

  it("accepts a system actor with a stable identifier", () => {
    const actor = systemAuditActor("retention-task");

    expect(actor).toEqual({
      type: AUDIT_ACTOR_TYPE.SYSTEM,
      id: "retention-task",
    });
    expect(isAuditActor(actor)).toBe(true);
  });

  it("refuses a user actor without a session", () => {
    expect(isAuditActor({ type: "user", id: "user-1" })).toBe(false);
    expect(isAuditActor({ type: "user", id: "user-1", sessionId: "" })).toBe(
      false,
    );
  });

  it("refuses a system actor that claims a session", () => {
    // The strict schema is what enforces this: a system action had no sign-in,
    // so a session identifier on one is either a mistake or a lie.
    expect(
      isAuditActor({
        type: "system",
        id: "retention-task",
        sessionId: "session-1",
      }),
    ).toBe(false);
  });

  it("refuses an unknown kind and a missing identifier", () => {
    expect(isAuditActor({ type: "service", id: "x" })).toBe(false);
    expect(isAuditActor({ type: "user", id: "", sessionId: "s" })).toBe(false);
    expect(isAuditActor({ type: "system", id: "  " })).toBe(false);
    expect(isAuditActor(null)).toBe(false);
    expect(isAuditActor("user-1")).toBe(false);
  });

  it("bounds both identifiers", () => {
    const long = "x".repeat(MAX_AUDIT_ACTOR_ID_LENGTH + 1);

    expect(isAuditActor({ type: "system", id: long })).toBe(false);
    expect(isAuditActor({ type: "user", id: "user-1", sessionId: long })).toBe(
      false,
    );
  });

  it("refuses any field beyond the contract", () => {
    for (const extra of [
      { email: "a@b.test" },
      { name: "Ada" },
      { roles: ["admin"] },
      { ipAddress: "127.0.0.1" },
      { userAgent: "curl" },
    ]) {
      expect(
        isAuditActor({
          type: "user",
          id: "user-1",
          sessionId: "session-1",
          ...extra,
        }),
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it("trims the identifiers it accepts", () => {
    expect(parseAuditActor({ type: "system", id: " task " })).toEqual({
      type: "system",
      id: "task",
    });
  });
});

describe("auditActorSessionId", () => {
  it("is the session for a user and null for the system", () => {
    expect(auditActorSessionId(userAuditActor("u", "s"))).toBe("s");
    expect(auditActorSessionId(systemAuditActor("task"))).toBeNull();
  });
});
