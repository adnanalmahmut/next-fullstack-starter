import { describe, expect, expectTypeOf, it } from "vitest";

import { LOG_STATUS } from "@/platform/observability/log-context";
import { ERROR_CODE } from "@/shared/errors/error-code";

import { ACTION_HOOK } from "./action-hooks";
import {
  ACTION_OUTCOME,
  SERVER_ACTION_LOG_EVENT,
  toServerActionLogFields,
  type ServerActionLogFields,
} from "./log-event";

const ALLOWED_LOG_KEYS = [
  "actionName",
  "requestId",
  "actorUserId",
  "durationMs",
  "outcome",
  "errorCode",
  "hookName",
] as const;

const actor = {
  userId: "user-1",
  sessionId: "session-1",
  name: "Recorded Name",
  email: "recorded@example.com",
  roles: ["admin"],
} as const;

describe("Server Action log events", () => {
  it("names the four stable events", () => {
    expect(SERVER_ACTION_LOG_EVENT).toEqual({
      STARTED: "server_action.started",
      SUCCEEDED: "server_action.succeeded",
      FAILED: "server_action.failed",
      HOOK_FAILED: "server_action.hook_failed",
    });
  });

  it("reports an outcome using the shared log status vocabulary", () => {
    expect(ACTION_OUTCOME).toEqual({
      SUCCEEDED: LOG_STATUS.SUCCEEDED,
      FAILED: LOG_STATUS.FAILED,
    });
  });
});

describe("toServerActionLogFields", () => {
  it("keeps only the action name when nothing else is known", () => {
    expect(
      toServerActionLogFields({ actionName: "catalog.product.create" }),
    ).toEqual({ actionName: "catalog.product.create" });
  });

  it("reduces an actor to its user id and drops the rest of it", () => {
    const fields = toServerActionLogFields({
      actionName: "catalog.product.create",
      actor,
    });

    expect(fields).toEqual({
      actionName: "catalog.product.create",
      actorUserId: "user-1",
    });
    expect(fields).not.toHaveProperty("sessionId");
    expect(fields).not.toHaveProperty("name");
    expect(fields).not.toHaveProperty("email");
    expect(fields).not.toHaveProperty("roles");
  });

  it("omits an absent value instead of serializing a null", () => {
    const fields = toServerActionLogFields({
      actionName: "catalog.product.create",
      requestId: undefined,
      actor: null,
      durationMs: undefined,
      outcome: undefined,
      errorCode: undefined,
      hookName: undefined,
    });

    expect(Object.keys(fields)).toEqual(["actionName"]);
  });

  it("carries every allowlisted field and nothing else", () => {
    const fields = toServerActionLogFields({
      actionName: "catalog.product.create",
      requestId: "0f1c4a0e-1d3f-4d5e-8a7b-9c0d1e2f3a4b",
      actor,
      durationMs: 12.5,
      outcome: ACTION_OUTCOME.FAILED,
      errorCode: ERROR_CODE.FORBIDDEN,
      hookName: ACTION_HOOK.AFTER_SUCCESS,
    });

    expect(fields).toEqual({
      actionName: "catalog.product.create",
      requestId: "0f1c4a0e-1d3f-4d5e-8a7b-9c0d1e2f3a4b",
      actorUserId: "user-1",
      durationMs: 12.5,
      outcome: "failed",
      errorCode: ERROR_CODE.FORBIDDEN,
      hookName: "afterSuccess",
    });
    expect(Object.keys(fields).toSorted()).toEqual(
      [...ALLOWED_LOG_KEYS].toSorted(),
    );
  });

  it("keeps a duration of zero rather than dropping it", () => {
    expect(
      toServerActionLogFields({
        actionName: "catalog.product.create",
        durationMs: 0,
      }),
    ).toEqual({ actionName: "catalog.product.create", durationMs: 0 });
  });

  it("closes the payload type over the allowlisted keys", () => {
    expectTypeOf<keyof ServerActionLogFields>().toEqualTypeOf<
      (typeof ALLOWED_LOG_KEYS)[number]
    >();
  });
});
