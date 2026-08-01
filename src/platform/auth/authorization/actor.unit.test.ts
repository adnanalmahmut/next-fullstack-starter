import { describe, expect, it } from "vitest";

import { type ActorSource, toActor } from "./actor";

function source(overrides: {
  role?: unknown;
  userId?: string;
  sessionId?: string;
}): ActorSource {
  return {
    session: {
      id: overrides.sessionId ?? "session-1",
      userId: overrides.userId ?? "user-1",
    },
    user: {
      id: overrides.userId ?? "user-1",
      name: "Test Person",
      email: "person@example.test",
      role: overrides.role,
    },
  };
}

describe("toActor", () => {
  it("returns null without a session", () => {
    expect(toActor(null)).toBeNull();
    expect(toActor(undefined)).toBeNull();
  });

  it("exposes only the normalized identity fields", () => {
    const actor = toActor(source({ role: "admin" }));

    expect(Object.keys(actor ?? {}).sort()).toEqual([
      "email",
      "name",
      "roles",
      "sessionId",
      "userId",
    ]);
  });

  it("reads the identity from the verified session", () => {
    const actor = toActor(
      source({ userId: "user-42", sessionId: "session-42", role: "user" }),
    );

    expect(actor).toEqual({
      userId: "user-42",
      sessionId: "session-42",
      name: "Test Person",
      email: "person@example.test",
      roles: ["user"],
    });
  });

  it("normalizes the multi-role representation", () => {
    expect(toActor(source({ role: " admin , user , admin " }))?.roles).toEqual([
      "admin",
      "user",
    ]);
  });

  it("produces an empty role list for a blank column", () => {
    expect(toActor(source({ role: null }))?.roles).toEqual([]);
    expect(toActor(source({ role: undefined }))?.roles).toEqual([]);
    expect(toActor(source({ role: "" }))?.roles).toEqual([]);
  });

  it("carries no token, cookie, address, or ban metadata", () => {
    const actor = toActor(source({ role: "admin" }));
    const serialized = JSON.stringify(actor);

    for (const forbidden of [
      "token",
      "cookie",
      "password",
      "ipAddress",
      "userAgent",
      "banned",
      "banReason",
      "permissions",
    ]) {
      expect(serialized.includes(forbidden), forbidden).toBe(false);
    }
  });
});
