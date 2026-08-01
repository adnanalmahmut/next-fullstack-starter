import { describe, expect, it } from "vitest";

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  UnauthenticatedError,
  ValidationError,
} from "@/shared/errors/application-error";

import { jsonError, jsonSuccess } from "./json-response";

describe("jsonSuccess", () => {
  it("wraps the payload in the success envelope", async () => {
    const response = jsonSuccess({ id: "user-1" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ data: { id: "user-1" } });
  });

  it("accepts an explicit status", () => {
    expect(jsonSuccess({ id: "user-1" }, 201).status).toBe(201);
  });

  it("carries an empty payload as a null envelope rather than no body", async () => {
    const response = jsonSuccess(null);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: null });
  });

  it("writes the headers it is given alongside the body", () => {
    const response = jsonSuccess({ id: "user-1" }, 200, {
      "x-request-id": "request-1",
    });

    expect(response.headers.get("x-request-id")).toBe("request-1");
  });
});

describe("jsonError", () => {
  it.each([
    {
      error: new ValidationError("invalid"),
      status: 400,
      code: "VALIDATION_FAILED",
    },
    {
      error: new UnauthenticatedError("none"),
      status: 401,
      code: "UNAUTHENTICATED",
    },
    { error: new ForbiddenError("denied"), status: 403, code: "FORBIDDEN" },
    { error: new NotFoundError("absent"), status: 404, code: "NOT_FOUND" },
    { error: new ConflictError("conflict"), status: 409, code: "CONFLICT" },
    {
      error: new RateLimitedError("too many"),
      status: 429,
      code: "RATE_LIMITED",
    },
  ])("maps $code to $status", async ({ error, status, code }) => {
    const response = jsonError(error);

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code } });
  });

  it("writes the headers it is given alongside the body", () => {
    const response = jsonError(new NotFoundError("absent"), {
      "x-request-id": "request-1",
    });

    expect(response.headers.get("x-request-id")).toBe("request-1");
  });

  it("hides an unexpected failure behind an internal code", async () => {
    const response = jsonError(
      new TypeError('relation "user" does not exist at /srv/app/prisma.ts'),
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({ error: { code: "INTERNAL_ERROR" } });
    expect(body).not.toContain("relation");
    expect(body).not.toContain("/srv/app");
  });

  it("trusts no provider-shaped object", async () => {
    const response = jsonError({ code: "FORBIDDEN", message: "spoofed" });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR" },
    });
  });
});
