import { describe, expect, it } from "vitest";

import { ForbiddenError } from "@/shared/errors/application-error";

import { assertRevokeSessionsAllowed } from "./revoke-sessions.policy";

describe("assertRevokeSessionsAllowed", () => {
  it("allows revoking another user's sessions", () => {
    expect(() =>
      assertRevokeSessionsAllowed({
        actorUserId: "actor-1",
        targetUserId: "target-1",
      }),
    ).not.toThrow();
  });

  it("refuses revoking your own sessions through the target-user operation", () => {
    expect(() =>
      assertRevokeSessionsAllowed({
        actorUserId: "same-user",
        targetUserId: "same-user",
      }),
    ).toThrow(ForbiddenError);
  });

  it("compares identifiers exactly", () => {
    expect(() =>
      assertRevokeSessionsAllowed({
        actorUserId: "user-1",
        targetUserId: "user-10",
      }),
    ).not.toThrow();
    expect(() =>
      assertRevokeSessionsAllowed({
        actorUserId: "User-1",
        targetUserId: "user-1",
      }),
    ).not.toThrow();
  });
});
