import type { DestinationStream } from "pino";
import { describe, expect, it, vi } from "vitest";

import { NotFoundError } from "@/shared/errors/application-error";
import { ERROR_CODE } from "@/shared/errors/error-code";

import {
  createApplicationLogger,
  type StructuredLogger,
} from "./create-logger.server";
import { isValidRequestId } from "./request-id.server";
import { reportRequestErrorSafely } from "./request-error-reporter.server";

type LogEntry = Record<string, unknown>;

function createCapture() {
  const output: string[] = [];
  const destination: DestinationStream = {
    write(message) {
      output.push(message);
    },
  };

  return {
    logger: createApplicationLogger({
      environment: "test",
      level: "trace",
      destination,
    }),
    entries: () => output.map((message) => JSON.parse(message) as LogEntry),
    raw: () => output.join(""),
  };
}

const requestContext = {
  routerKind: "App Router" as const,
  routePath: "/[locale]/private",
  routeType: "render",
};

describe("request error reporter", () => {
  it("logs an expected application error at warn with safe fields", () => {
    const capture = createCapture();
    const requestId = "123e4567-e89b-42d3-a456-426614174000";

    reportRequestErrorSafely(
      new NotFoundError("SQL entity lookup failed"),
      {
        method: "GET",
        headers: { "X-Request-Id": requestId },
      },
      requestContext,
      capture.logger,
    );

    expect(capture.entries()).toEqual([
      expect.objectContaining({
        level: 40,
        msg: "request.failed",
        requestId,
        route: "/[locale]/private",
        method: "GET",
        routerKind: "App Router",
        operation: "render",
        status: "failed",
        errorType: "application",
        errorCode: ERROR_CODE.NOT_FOUND,
      }),
    ]);
    expect(capture.raw()).not.toContain("SQL entity lookup failed");
  });

  it("logs an unexpected error at error without internal details", () => {
    const capture = createCapture();
    const error = Object.assign(new Error("SELECT token FROM private_table"), {
      code: "P2002",
      query: "SELECT token FROM private_table",
    });

    reportRequestErrorSafely(
      error,
      {
        method: "POST",
        headers: {
          "x-request-id": "invalid",
          authorization: "Bearer authorization-secret",
          cookie: "session=cookie-secret",
        },
      },
      requestContext,
      capture.logger,
    );

    const [entry] = capture.entries();

    expect(entry).toEqual(
      expect.objectContaining({
        level: 50,
        errorType: "unexpected",
        errorCode: ERROR_CODE.INTERNAL_ERROR,
      }),
    );
    expect(isValidRequestId(entry?.requestId)).toBe(true);
    expect(capture.raw()).not.toContain("SELECT");
    expect(capture.raw()).not.toContain("private_table");
    expect(capture.raw()).not.toContain("P2002");
    expect(capture.raw()).not.toContain("authorization-secret");
    expect(capture.raw()).not.toContain("cookie-secret");
    expect(entry).not.toHaveProperty("stack");
    expect(entry).not.toHaveProperty("cause");
    expect(entry).not.toHaveProperty("message");
  });

  it("creates a request ID when the header is absent", () => {
    const capture = createCapture();

    reportRequestErrorSafely(
      "non-error failure",
      { method: "GET", headers: {} },
      requestContext,
      capture.logger,
    );

    expect(isValidRequestId(capture.entries()[0]?.requestId)).toBe(true);
  });

  it("does not replace application behavior when logging fails", () => {
    const brokenLogger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: () => {
        throw new Error("Logger destination unavailable");
      },
    } as unknown as StructuredLogger;

    expect(() =>
      reportRequestErrorSafely(
        new Error("Original error"),
        { method: "GET", headers: {} },
        requestContext,
        brokenLogger,
      ),
    ).not.toThrow();
  });
});
