import { describe, expect, it } from "vitest";

import type { Actor } from "@/platform/auth/authorization/actor";
import { ERROR_CODE } from "@/shared/errors/error-code";

import { ROUTE_LOG_EVENT, toRouteLogFields } from "./log-event";
import { ROUTE_HOOK } from "./route-hooks";

const base = {
  routeName: "identity.user.list",
  method: "GET",
  requestId: "0f1c4a0e-1d3f-4d5e-8a7b-9c0d1e2f3a4b",
} as const;

describe("route log events", () => {
  it("names every event under one stable prefix", () => {
    expect(Object.values(ROUTE_LOG_EVENT)).toEqual([
      "route.started",
      "route.succeeded",
      "route.failed",
      "route.hook_failed",
      "route.replayed",
    ]);
  });
});

describe("toRouteLogFields", () => {
  it("carries the always-present fields", () => {
    expect(toRouteLogFields(base)).toEqual(base);
  });

  it("reduces an actor to its user id", () => {
    // A whole actor, as the factory holds it. The declared field type accepts
    // only the user id, so the rest is dropped rather than serialized.
    const actor: Actor = {
      userId: "user-1",
      sessionId: "session-1",
      name: "Ada Lovelace",
      email: "ada@example.com",
      roles: ["admin"],
    };

    const fields = toRouteLogFields({ ...base, actor });

    expect(fields).toEqual({ ...base, actorUserId: "user-1" });
    expect(JSON.stringify(fields)).not.toContain("ada@example.com");
    expect(JSON.stringify(fields)).not.toContain("Ada Lovelace");
    expect(JSON.stringify(fields)).not.toContain("session-1");
  });

  it("omits an absent value rather than reporting null", () => {
    const fields = toRouteLogFields({ ...base, actor: null });

    expect(Object.keys(fields)).toEqual(["routeName", "method", "requestId"]);
  });

  it("carries every allowlisted optional field", () => {
    expect(
      toRouteLogFields({
        ...base,
        actor: { userId: "user-1" },
        durationMs: 12,
        statusCode: 409,
        errorCode: ERROR_CODE.CONFLICT,
        hookName: ROUTE_HOOK.AUDIT,
        replayed: true,
      }),
    ).toEqual({
      ...base,
      actorUserId: "user-1",
      durationMs: 12,
      statusCode: 409,
      errorCode: ERROR_CODE.CONFLICT,
      hookName: "audit",
      replayed: true,
    });
  });

  it("carries a false replay flag rather than dropping it", () => {
    expect(toRouteLogFields({ ...base, replayed: false })).toEqual({
      ...base,
      replayed: false,
    });
  });
});
