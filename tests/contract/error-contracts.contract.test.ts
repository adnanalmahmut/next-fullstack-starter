import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  actionFailure,
  actionSuccess,
  type ActionResult,
} from "@/platform/actions/action-result";
import type { PublicError } from "@/platform/errors/public-error";
import { toPublicError } from "@/platform/errors/to-public-error";
import {
  HTTP_STATUS_BY_ERROR_CODE,
  type HttpErrorResponse,
  type HttpSuccessResponse,
} from "@/platform/http/http-response";
import {
  ConflictError,
  NotFoundError,
} from "@/shared/errors/application-error";
import { ERROR_CODE } from "@/shared/errors/error-code";

const clientSafeContractFiles = [
  "src/shared/errors/error-code.ts",
  "src/platform/errors/public-error.ts",
  "src/platform/actions/action-result.ts",
  "src/platform/http/http-response.ts",
] as const;

function readImports(filePath: string): string[] {
  const source = readFileSync(resolve(process.cwd(), filePath), "utf8");
  const importPattern = /(?:from\s+|import\s*)["']([^"']+)["']/g;

  return Array.from(source.matchAll(importPattern), (match) => match[1]);
}

describe("public error contract", () => {
  it("is stable and serializable without internal error details", () => {
    const cause = new Error("Database connection failed");
    const error = new NotFoundError("Internal entity lookup failed", { cause });
    const publicError = toPublicError(error);

    expect(publicError).toEqual({ code: ERROR_CODE.NOT_FOUND });
    expect(JSON.parse(JSON.stringify(publicError))).toEqual({
      code: ERROR_CODE.NOT_FOUND,
    });
    expect(Object.keys(publicError)).toEqual(["code"]);
    expect(publicError).not.toHaveProperty("message");
    expect(publicError).not.toHaveProperty("stack");
    expect(publicError).not.toHaveProperty("cause");
  });

  it("normalizes unknown exceptions without exposing their values", () => {
    const unknownValues = [
      new Error("Unexpected internal failure"),
      "Unexpected internal failure",
      null,
      undefined,
    ];

    for (const value of unknownValues) {
      expect(toPublicError(value)).toEqual({
        code: ERROR_CODE.INTERNAL_ERROR,
      });
    }
  });

  it("does not trust or expose a Prisma-like object", () => {
    const prismaLikeError = {
      name: "PrismaClientKnownRequestError",
      code: "P2002",
      message: "Unique constraint failed",
      meta: { target: ["email"] },
      stack: "internal stack",
    };

    expect(toPublicError(prismaLikeError)).toEqual({
      code: ERROR_CODE.INTERNAL_ERROR,
    });
  });

  it("does not expose a SQL-like error", () => {
    const sqlLikeError = Object.assign(
      new Error('relation "private_table" does not exist'),
      {
        code: "42P01",
        query: "SELECT * FROM private_table",
      },
    );

    expect(toPublicError(sqlLikeError)).toEqual({
      code: ERROR_CODE.INTERNAL_ERROR,
    });
  });
});

describe("Action result contract", () => {
  it("keeps the success shape stable", () => {
    const result: ActionResult<{ id: string }> = actionSuccess({
      id: "entity-id",
    });

    expect(JSON.parse(JSON.stringify(result))).toEqual({
      ok: true,
      data: { id: "entity-id" },
    });
  });

  it("keeps the failure shape stable", () => {
    const result: ActionResult<never> = actionFailure(
      toPublicError(new ConflictError("Internal conflict")),
    );

    expect(JSON.parse(JSON.stringify(result))).toEqual({
      ok: false,
      error: { code: ERROR_CODE.CONFLICT },
    });
  });
});

describe("HTTP response contract", () => {
  it("keeps the success response shape stable", () => {
    const response: HttpSuccessResponse<{ id: string }> = {
      data: { id: "entity-id" },
    };

    expect(JSON.parse(JSON.stringify(response))).toEqual({
      data: { id: "entity-id" },
    });
  });

  it("keeps the error response shape stable", () => {
    const error: PublicError = { code: ERROR_CODE.FORBIDDEN };
    const response: HttpErrorResponse = { error };

    expect(JSON.parse(JSON.stringify(response))).toEqual({
      error: { code: ERROR_CODE.FORBIDDEN },
    });
  });

  it("maps every public error code to an HTTP status", () => {
    expect(Object.keys(HTTP_STATUS_BY_ERROR_CODE).sort()).toEqual(
      Object.values(ERROR_CODE).sort(),
    );
  });
});

describe("client-safe architecture contract", () => {
  it.each(clientSafeContractFiles)(
    "%s has no server-only dependency",
    (filePath) => {
      expect(readImports(filePath)).not.toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^(?:server-only|next(?:\/|$)|react(?:\/|$)|@prisma(?:\/|$)|prisma$|pg$|node:)/,
          ),
        ]),
      );
    },
  );

  it("keeps shared error primitives independent from platform code", () => {
    expect(readImports("src/shared/errors/error-code.ts")).toEqual([]);
    expect(readImports("src/shared/errors/application-error.ts")).toEqual([
      "./error-code",
    ]);
  });
});
