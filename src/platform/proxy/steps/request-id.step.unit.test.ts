import { NextRequest, NextResponse } from "next/server";
import { describe, expect, it } from "vitest";

import { REQUEST_ID_HEADER } from "@/platform/observability/request-id.server";

import {
  applyRequestIdToRequest,
  applyRequestIdToResponse,
} from "./request-id.step";

const validRequestId = "123e4567-e89b-42d3-a456-426614174000";
const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createRequest(incomingRequestId?: string): NextRequest {
  return new NextRequest(
    "http://localhost/ar",
    incomingRequestId === undefined
      ? undefined
      : {
          headers: {
            [REQUEST_ID_HEADER]: incomingRequestId,
          },
        },
  );
}

describe("applyRequestIdToRequest", () => {
  it("keeps a valid incoming request ID", () => {
    const request = createRequest(validRequestId);

    expect(applyRequestIdToRequest(request)).toBe(validRequestId);
    expect(request.headers.get(REQUEST_ID_HEADER)).toBe(validRequestId);
  });

  it("keeps a valid incoming request ID in upper case", () => {
    const upperCaseRequestId = validRequestId.toUpperCase();
    const request = createRequest(upperCaseRequestId);

    expect(applyRequestIdToRequest(request)).toBe(upperCaseRequestId);
  });

  it.each([
    { name: "a missing value", incoming: undefined },
    { name: "an empty value", incoming: "" },
    { name: "a malformed value", incoming: "not-a-request-id" },
    { name: "an oversized value", incoming: `${validRequestId}extra` },
    {
      name: "a non-version-4 value",
      incoming: "123e4567-e89b-12d3-a456-426614174000",
    },
  ])("replaces $name with a generated UUID", ({ incoming }) => {
    const request = createRequest(incoming);
    const requestId = applyRequestIdToRequest(request);

    expect(requestId).toMatch(requestIdPattern);
    expect(requestId).not.toBe(incoming);
    expect(request.headers.get(REQUEST_ID_HEADER)).toBe(requestId);
  });

  it("writes exactly one request ID header", () => {
    const request = createRequest("not-a-request-id");

    applyRequestIdToRequest(request);

    const requestIdHeaders = [...request.headers.entries()].filter(
      ([name]) => name === REQUEST_ID_HEADER,
    );

    expect(requestIdHeaders).toHaveLength(1);
  });

  it("generates a distinct value per request", () => {
    const first = applyRequestIdToRequest(createRequest());
    const second = applyRequestIdToRequest(createRequest());

    expect(first).not.toBe(second);
  });
});

describe("applyRequestIdToResponse", () => {
  it("returns the resolved request ID on the response", () => {
    const request = createRequest(validRequestId);
    const response = NextResponse.next();
    const requestId = applyRequestIdToRequest(request);

    applyRequestIdToResponse(response, requestId);

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(validRequestId);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(
      request.headers.get(REQUEST_ID_HEADER),
    );
  });

  it("replaces an existing response value instead of appending", () => {
    const response = NextResponse.next();

    applyRequestIdToResponse(response, validRequestId);
    applyRequestIdToResponse(response, validRequestId);

    expect(
      [...response.headers.entries()].filter(
        ([name]) => name === REQUEST_ID_HEADER,
      ),
    ).toHaveLength(1);
  });
});
