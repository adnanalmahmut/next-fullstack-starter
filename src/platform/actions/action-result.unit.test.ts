import { describe, expect, expectTypeOf, it } from "vitest";

import { ERROR_CODE, type ErrorCode } from "@/shared/errors/error-code";

import type { PublicError } from "@/platform/errors/public-error";

import {
  actionFailure,
  actionSuccess,
  type ActionFailure,
  type ActionResult,
  type ActionSuccess,
} from "./action-result";

describe("action result", () => {
  it("constructs a successful result", () => {
    const result = actionSuccess({ id: "entity-id" });

    expect(result).toEqual({
      ok: true,
      data: { id: "entity-id" },
    });
    expectTypeOf(result).toEqualTypeOf<ActionSuccess<{ id: string }>>();
  });

  it("constructs a failed result", () => {
    const error: PublicError = { code: ERROR_CODE.FORBIDDEN };
    const result = actionFailure(error);

    expect(result).toEqual({
      ok: false,
      error: { code: ERROR_CODE.FORBIDDEN },
    });
    expectTypeOf(result).toEqualTypeOf<ActionFailure<PublicError>>();
  });

  it("narrows the discriminated union by ok", () => {
    const readResult = (result: ActionResult<number>): number | ErrorCode => {
      if (result.ok) {
        expectTypeOf(result).toEqualTypeOf<ActionSuccess<number>>();
        return result.data;
      }

      expectTypeOf(result).toEqualTypeOf<ActionFailure<PublicError>>();
      return result.error.code;
    };

    expect(readResult(actionSuccess(42))).toBe(42);
    expect(
      readResult(actionFailure({ code: ERROR_CODE.VALIDATION_FAILED })),
    ).toBe(ERROR_CODE.VALIDATION_FAILED);
  });

  it("preserves an extended safe public error type", () => {
    type ValidationPublicError = PublicError & {
      fields: Readonly<Record<string, readonly string[]>>;
    };

    const error: ValidationPublicError = {
      code: ERROR_CODE.VALIDATION_FAILED,
      fields: { email: ["invalid"] },
    };
    const result = actionFailure(error);

    expectTypeOf(result).toEqualTypeOf<ActionFailure<ValidationPublicError>>();
    expect(result.error.fields).toEqual({ email: ["invalid"] });
  });
});
