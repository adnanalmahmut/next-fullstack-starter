import { describe, expect, it } from "vitest";

import {
  ConflictError,
  DependencyUnavailableError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  RateLimitedError,
  UnauthenticatedError,
  ValidationError,
} from "@/shared/errors/application-error";

import {
  ERROR_BOUNDARY,
  EXPECTED_ERROR_CODES,
  isReportableError,
  NOOP_ERROR_MONITOR,
} from "./error-monitor";

describe("the boundary set", () => {
  it("names exactly the five boundaries that own a failure", () => {
    expect(ERROR_BOUNDARY).toEqual({
      REQUEST: "request",
      ROUTE: "route",
      SERVER_ACTION: "server_action",
      JOB: "job",
      OUTBOX: "outbox",
    });
  });
});

describe("deciding what is worth reporting", () => {
  it.each([
    { name: "a validation failure", error: new ValidationError("bad input") },
    { name: "an unauthenticated call", error: new UnauthenticatedError("no") },
    { name: "a forbidden call", error: new ForbiddenError("no") },
    { name: "a missing resource", error: new NotFoundError("gone") },
    { name: "a conflict", error: new ConflictError("taken") },
    { name: "a refused rate", error: new RateLimitedError("slow down") },
  ])("does not report $name", ({ error }) => {
    // A refused request is a working application. Reporting these would bury the
    // failures that need a human under the ones that need nobody.
    expect(isReportableError(error)).toBe(false);
  });

  it("reports an unexpected internal failure", () => {
    expect(isReportableError(new InternalError("defect"))).toBe(true);
  });

  it("reports an unreachable dependency", () => {
    // Not a defect, but an operational failure worth a report: a capability the
    // request genuinely needed could not be reached.
    expect(isReportableError(new DependencyUnavailableError("no redis"))).toBe(
      true,
    );
    expect(EXPECTED_ERROR_CODES).not.toContain("DEPENDENCY_UNAVAILABLE");
  });

  it("reports a plain error and a non-error throw", () => {
    expect(isReportableError(new Error("boom"))).toBe(true);
    expect(isReportableError("boom")).toBe(true);
    expect(isReportableError(undefined)).toBe(true);
  });

  it("keeps the expected set closed and stable", () => {
    expect([...EXPECTED_ERROR_CODES]).toEqual([
      "VALIDATION_FAILED",
      "UNAUTHENTICATED",
      "FORBIDDEN",
      "NOT_FOUND",
      "CONFLICT",
      "RATE_LIMITED",
    ]);
  });
});

describe("the no-op monitor", () => {
  it("captures, flushes, and shuts down without doing anything", async () => {
    expect(
      NOOP_ERROR_MONITOR.capture(new Error("boom"), {
        boundary: ERROR_BOUNDARY.ROUTE,
      }),
    ).toBeUndefined();
    await expect(NOOP_ERROR_MONITOR.flush(10)).resolves.toBeUndefined();
    await expect(NOOP_ERROR_MONITOR.shutdown()).resolves.toBeUndefined();
  });
});
