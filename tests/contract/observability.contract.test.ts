import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { resolve } from "node:path";

import { ESLint } from "eslint";
import type { DestinationStream } from "pino";
import { describe, expect, it } from "vitest";

import { createApplicationLogger } from "@/platform/observability/create-logger.server";
import { LOG_EVENT } from "@/platform/observability/log-event";
import { LOG_STATUS } from "@/platform/observability/log-context";
import {
  isValidRequestId,
  REQUEST_ID_HEADER,
} from "@/platform/observability/request-id.server";
import { toSafeLogError } from "@/platform/observability/safe-error";
import { NotFoundError } from "@/shared/errors/application-error";
import { ERROR_CODE } from "@/shared/errors/error-code";

const projectRoot = process.cwd();
const observabilityRoot = resolve(projectRoot, "src/platform/observability");

function readProjectFile(filePath: string): string {
  return readFileSync(resolve(projectRoot, filePath), "utf8");
}

function sourceFiles(
  directory: string,
  entries: Dirent[] = readdirSync(directory, { withFileTypes: true }),
): string[] {
  return entries.flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(entryPath);
    }

    return entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

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
    entries: () =>
      output.map((message) => JSON.parse(message) as Record<string, unknown>),
    raw: () => output.join(""),
  };
}

describe("observability contracts", () => {
  it("keeps the JSON log envelope stable", () => {
    const capture = createCapture();

    capture.logger
      .child({
        requestId: "123e4567-e89b-42d3-a456-426614174000",
        module: "catalog",
        operation: "read",
        status: LOG_STATUS.SUCCEEDED,
      })
      .info("operation.succeeded");

    const [entry] = capture.entries();

    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "environment",
      "level",
      "module",
      "msg",
      "operation",
      "requestId",
      "service",
      "status",
      "time",
    ]);
    expect(entry).toEqual(
      expect.objectContaining({
        service: "next-fullstack-starter",
        environment: "test",
        level: 30,
        msg: LOG_EVENT.OPERATION_SUCCEEDED,
      }),
    );
  });

  it("keeps stable event and status identifiers", () => {
    expect(LOG_EVENT).toEqual({
      APPLICATION_STARTED: "application.started",
      REQUEST_FAILED: "request.failed",
      OPERATION_STARTED: "operation.started",
      OPERATION_SUCCEEDED: "operation.succeeded",
      OPERATION_FAILED: "operation.failed",
      JOB_STARTED: "job.started",
      JOB_SUCCEEDED: "job.succeeded",
      JOB_FAILED: "job.failed",
    });
    expect(LOG_STATUS).toEqual({
      STARTED: "started",
      SUCCEEDED: "succeeded",
      FAILED: "failed",
    });
  });

  it("removes credentials, tokens, cookies, requests, and sessions", () => {
    const capture = createCapture();
    const secrets = [
      "password-value",
      "token-value",
      "authorization-value",
      "cookie-value",
      "request-value",
      "session-value",
    ];

    capture.logger.info(
      {
        password: secrets[0],
        payload: { refreshToken: secrets[1] },
        headers: {
          Authorization: secrets[2],
          Cookie: secrets[3],
        },
        request: { body: secrets[4] },
        session: { id: secrets[5] },
      },
      "redaction.contract",
    );

    for (const secret of secrets) {
      expect(capture.raw()).not.toContain(secret);
    }
  });

  it("serializes only safe error classification fields", () => {
    const diagnostic = new NotFoundError("private diagnostic", {
      cause: new Error("database secret"),
    });
    const known = toSafeLogError(diagnostic);
    const unknown = toSafeLogError({
      name: "PrismaClientKnownRequestError",
      code: "P2002",
      query: "SELECT * FROM private_table",
    });

    expect(known).toEqual({
      errorType: "application",
      errorCode: ERROR_CODE.NOT_FOUND,
    });
    expect(unknown).toEqual({
      errorType: "non-error",
      errorCode: ERROR_CODE.INTERNAL_ERROR,
    });

    for (const value of [known, unknown]) {
      expect(Object.keys(value).sort()).toEqual(["errorCode", "errorType"]);
      expect(value).not.toHaveProperty("message");
      expect(value).not.toHaveProperty("stack");
      expect(value).not.toHaveProperty("cause");
      expect(value).not.toHaveProperty("query");
    }
  });

  it("uses the stable bounded UUID request ID contract", () => {
    const requestId = "123e4567-e89b-42d3-a456-426614174000";

    expect(REQUEST_ID_HEADER).toBe("x-request-id");
    expect(isValidRequestId(requestId)).toBe(true);
    expect(isValidRequestId(`${requestId}extra`)).toBe(false);
    expect(isValidRequestId("P2002")).toBe(false);
  });

  it("marks every Node observability implementation as server-only", () => {
    const serverFiles = sourceFiles(observabilityRoot).filter(
      (filePath) =>
        filePath.endsWith(".server.ts") && !filePath.endsWith(".unit.test.ts"),
    );

    expect(serverFiles.length).toBeGreaterThan(0);

    for (const filePath of serverFiles) {
      expect(readFileSync(filePath, "utf8")).toMatch(/^import "server-only";/);
    }
  });

  it("keeps framework-independent observability contracts client-neutral", () => {
    const contractFiles = [
      "src/platform/observability/log-context.ts",
      "src/platform/observability/log-event.ts",
      "src/platform/observability/redaction.ts",
      "src/platform/observability/safe-error.ts",
    ];
    const restrictedImport =
      /(?:from\s+|import\s*)["'](?:server-only|node:|next(?:\/|["'])|react(?:\/|["'])|pino(?:\/|["'])|@prisma(?:\/|["']))/;

    for (const filePath of contractFiles) {
      expect(readProjectFile(filePath)).not.toMatch(restrictedImport);
    }
  });

  it("keeps the server entry controlled and avoids broad re-exports", () => {
    const source = readProjectFile(
      "src/platform/observability/index.server.ts",
    );

    expect(source).toMatch(/^import "server-only";/);
    expect(source).not.toMatch(/export\s+\*/);
  });

  it("keeps redaction centralized and request context scoped", () => {
    const loggerSource = readProjectFile(
      "src/platform/observability/create-logger.server.ts",
    );
    const contextSource = readProjectFile(
      "src/platform/observability/request-context.server.ts",
    );

    expect(loggerSource).toContain(
      'import { SENSITIVE_LOG_PATHS } from "./redaction"',
    );
    expect(loggerSource).toContain("paths: [...SENSITIVE_LOG_PATHS]");
    expect(contextSource).toContain("new AsyncLocalStorage<RequestContext>()");
    expect(contextSource).toContain("requestContextStorage.run(");
    expect(contextSource).not.toContain(".enterWith(");
  });

  it("loads Node observability dynamically from instrumentation", () => {
    const source = readProjectFile("src/instrumentation.ts");

    expect(source).toContain('process.env.NEXT_RUNTIME !== "nodejs"');
    expect(source).toContain("await import(");
    expect(source).not.toMatch(/^import\s+.*platform\/observability.*from/m);
    expect(source).not.toMatch(/sentry|opentelemetry/i);
  });

  it("does not pass raw request, headers, sessions, or errors to Pino", () => {
    const reporterSource = readProjectFile(
      "src/platform/observability/request-error-reporter.server.ts",
    );

    expect(reporterSource).not.toMatch(
      /\.(?:info|warn|error|fatal)\(\s*\{[\s\S]*?\b(?:request|headers|session|error)\b/,
    );
    expect(reporterSource).not.toContain("...error");
    expect(reporterSource).not.toContain("request.path");
  });

  it("propagates the request ID through the proxy pipeline", () => {
    const stepSource = readProjectFile(
      "src/platform/proxy/steps/request-id.step.ts",
    );

    expect(stepSource).toContain(
      "request.headers.set(REQUEST_ID_HEADER, requestId)",
    );
    expect(stepSource).toContain(
      "response.headers.set(REQUEST_ID_HEADER, requestId)",
    );

    const composeSource = readProjectFile("src/platform/proxy/compose.ts");
    const requestStep = composeSource.indexOf(
      "applyRequestIdToRequest(request)",
    );
    const localeStep = composeSource.indexOf("applyLocaleRouting(context)");
    const responseStep = composeSource.indexOf(
      "applyRequestIdToResponse(response, context.requestId)",
    );

    expect(requestStep).toBeGreaterThan(-1);
    expect(localeStep).toBeGreaterThan(requestStep);
    expect(responseStep).toBeGreaterThan(localeStep);
  });

  // A fresh ESLint instance resolves the flat config and builds the type-aware
  // program before it can lint a single line, which exceeds the default
  // per-test budget.
  const eslintLintTimeout = 20_000;

  it(
    "enforces the production console restriction",
    async () => {
      const eslint = new ESLint({ cwd: projectRoot });
      const [result] = await eslint.lintText('console.log("not allowed");', {
        filePath: "src/platform/observability/console-fixture.ts",
      });

      expect(result?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: "no-console",
            severity: 2,
          }),
        ]),
      );
    },
    eslintLintTimeout,
  );
});
