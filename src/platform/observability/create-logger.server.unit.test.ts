import type { DestinationStream } from "pino";
import { describe, expect, it } from "vitest";

import { ERROR_CODE } from "@/shared/errors/error-code";

import {
  createApplicationLogger,
  defaultLogLevel,
} from "./create-logger.server";
import { createContextLogger, getRequestLogger, logger } from "./logger.server";
import { startOperationTimer } from "./operation-timer.server";
import { runWithRequestContext } from "./request-context.server";

type LogEntry = Record<string, unknown>;

function createCapture() {
  const output: string[] = [];
  const destination: DestinationStream = {
    write(message) {
      output.push(message);
    },
  };
  const logger = createApplicationLogger({
    environment: "test",
    level: "trace",
    destination,
  });

  return {
    logger,
    entries: () => output.map((message) => JSON.parse(message) as LogEntry),
    raw: () => output.join(""),
  };
}

describe("structured logger", () => {
  it("writes JSON with stable base fields and standard levels", () => {
    const capture = createCapture();

    capture.logger.trace("trace.event");
    capture.logger.debug("debug.event");
    capture.logger.info("info.event");
    capture.logger.warn("warn.event");
    capture.logger.error("error.event");
    capture.logger.fatal("fatal.event");

    expect(capture.entries()).toEqual([
      expect.objectContaining({
        service: "next-fullstack-starter",
        environment: "test",
        level: 10,
        msg: "trace.event",
      }),
      expect.objectContaining({ level: 20, msg: "debug.event" }),
      expect.objectContaining({ level: 30, msg: "info.event" }),
      expect.objectContaining({ level: 40, msg: "warn.event" }),
      expect.objectContaining({ level: 50, msg: "error.event" }),
      expect.objectContaining({ level: 60, msg: "fatal.event" }),
    ]);
    expect(capture.entries()[0]).toHaveProperty("time");
  });

  it("uses safe environment-specific default levels", () => {
    expect(defaultLogLevel("development")).toBe("debug");
    expect(defaultLogLevel("test")).toBe("silent");
    expect(defaultLogLevel("staging")).toBe("info");
    expect(defaultLogLevel("production")).toBe("info");
  });

  it("respects the configured minimum level", () => {
    const output: string[] = [];
    const logger = createApplicationLogger({
      environment: "test",
      level: "warn",
      destination: {
        write(message) {
          output.push(message);
        },
      },
    });

    logger.debug("operation.debug");
    logger.info("operation.info");
    logger.warn("operation.warned");

    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] ?? "{}")).toEqual(
      expect.objectContaining({
        level: 40,
        msg: "operation.warned",
      }),
    );
  });

  it("inherits request and child context without leaking it to the root", () => {
    const capture = createCapture();

    capture.logger.info("root.before");

    runWithRequestContext(
      {
        requestId: "123e4567-e89b-42d3-a456-426614174000",
        route: "/[locale]",
      },
      () => {
        createContextLogger(capture.logger, {
          module: "catalog",
          operation: "read",
        }).info("operation.succeeded");
      },
    );

    capture.logger.info("root.after");

    const [before, child, after] = capture.entries();

    expect(before).not.toHaveProperty("requestId");
    expect(child).toEqual(
      expect.objectContaining({
        requestId: "123e4567-e89b-42d3-a456-426614174000",
        route: "/[locale]",
        module: "catalog",
        operation: "read",
      }),
    );
    expect(after).not.toHaveProperty("requestId");
  });

  it("keeps the scoped request ID authoritative", () => {
    const capture = createCapture();

    runWithRequestContext(
      { requestId: "123e4567-e89b-42d3-a456-426614174000" },
      () => {
        createContextLogger(capture.logger, {
          requestId: "223e4567-e89b-42d3-a456-426614174000",
        }).info("request.correlated");
      },
    );

    expect(capture.entries()[0]).toEqual(
      expect.objectContaining({
        requestId: "123e4567-e89b-42d3-a456-426614174000",
      }),
    );
  });

  it("keeps sibling child bindings isolated", () => {
    const capture = createCapture();
    const first = capture.logger.child({
      requestId: "123e4567-e89b-42d3-a456-426614174000",
    });
    const second = capture.logger.child({
      requestId: "223e4567-e89b-42d3-a456-426614174000",
    });

    first.info("request.first");
    second.info("request.second");

    expect(capture.entries()).toEqual([
      expect.objectContaining({
        requestId: "123e4567-e89b-42d3-a456-426614174000",
        msg: "request.first",
      }),
      expect.objectContaining({
        requestId: "223e4567-e89b-42d3-a456-426614174000",
        msg: "request.second",
      }),
    ]);
  });

  it("returns the supplied root logger when no context exists", () => {
    const capture = createCapture();

    expect(createContextLogger(capture.logger)).toBe(capture.logger);
    expect(getRequestLogger()).toBe(logger);

    runWithRequestContext(
      { requestId: "123e4567-e89b-42d3-a456-426614174000" },
      () => {
        expect(getRequestLogger()).not.toBe(logger);
      },
    );
  });

  it("records a finite non-negative operation duration", () => {
    const capture = createCapture();
    const durationMs = startOperationTimer().elapsedMs();

    capture.logger.info(
      {
        durationMs,
        status: "succeeded",
        errorCode: ERROR_CODE.INTERNAL_ERROR,
      },
      "operation.succeeded",
    );

    expect(capture.entries()[0]).toEqual(
      expect.objectContaining({
        durationMs: expect.any(Number),
        status: "succeeded",
        errorCode: ERROR_CODE.INTERNAL_ERROR,
      }),
    );
    expect(Number.isFinite(durationMs)).toBe(true);
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  it("removes sensitive fields and nested request-shaped values", () => {
    const capture = createCapture();

    capture.logger
      .child({
        requestId: "123e4567-e89b-42d3-a456-426614174000",
        module: "identity",
        operation: "credential.rotate",
        status: "failed",
        errorCode: ERROR_CODE.INTERNAL_ERROR,
      })
      .info(
        {
          password: "password-secret",
          CurrentPassword: "current-password-secret",
          payload: {
            accessToken: "access-token-secret",
            nested: {
              clientSecret: "client-secret-value",
            },
          },
          headers: {
            Authorization: "Bearer authorization-secret",
            Cookie: "session=cookie-secret",
          },
          request: {
            url: "/private?token=query-secret",
            headers: { authorization: "Bearer nested-secret" },
          },
          req: { body: { apiKey: "api-key-secret" } },
          session: { sessionToken: "session-token-secret" },
        },
        "redaction.checked",
      );

    const raw = capture.raw();
    const [entry] = capture.entries();

    expect(raw).not.toContain("password-secret");
    expect(raw).not.toContain("access-token-secret");
    expect(raw).not.toContain("client-secret-value");
    expect(raw).not.toContain("authorization-secret");
    expect(raw).not.toContain("cookie-secret");
    expect(raw).not.toContain("query-secret");
    expect(raw).not.toContain("api-key-secret");
    expect(raw).not.toContain("session-token-secret");
    expect(entry).not.toHaveProperty("password");
    expect(entry).not.toHaveProperty("request");
    expect(entry).not.toHaveProperty("req");
    expect(entry).not.toHaveProperty("session");
    expect(entry).toEqual(
      expect.objectContaining({
        requestId: "123e4567-e89b-42d3-a456-426614174000",
        module: "identity",
        operation: "credential.rotate",
        status: "failed",
        errorCode: ERROR_CODE.INTERNAL_ERROR,
      }),
    );
  });

  it("serializes raw error fields through the safe classifier", () => {
    const capture = createCapture();
    const knownTokenValue = "known-token-value-42";

    capture.logger.error(
      {
        err: new Error(`SELECT secret FROM private_table ${knownTokenValue}`),
        error: {
          name: "PrismaClientKnownRequestError",
          code: "P2002",
          meta: { target: ["token"] },
        },
      },
      "error.safely-classified",
    );

    const [entry] = capture.entries();
    const raw = capture.raw();

    expect(entry?.err).toEqual({
      errorType: "unexpected",
      errorCode: ERROR_CODE.INTERNAL_ERROR,
    });
    expect(entry?.error).toEqual({
      errorType: "non-error",
      errorCode: ERROR_CODE.INTERNAL_ERROR,
    });
    expect(raw).not.toContain("SELECT");
    expect(raw).not.toContain("private_table");
    expect(raw).not.toContain("Prisma");
    expect(raw).not.toContain("P2002");
    expect(raw).not.toContain(knownTokenValue);
  });
});
