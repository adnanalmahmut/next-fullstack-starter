import { describe, expect, it } from "vitest";

import { ValidationError } from "@/shared/errors/application-error";

import { MAX_AUDIT_CURSOR_LENGTH } from "./audit-cursor";
import {
  AUDIT_LIST_DEFAULT_LIMIT,
  AUDIT_LIST_MAX_LIMIT,
  parseAuditListQuery,
} from "./audit-query";

describe("parseAuditListQuery", () => {
  it("defaults to a bounded first page", () => {
    expect(parseAuditListQuery({})).toEqual({
      limit: AUDIT_LIST_DEFAULT_LIMIT,
    });
  });

  it("coerces and bounds the page size", () => {
    expect(parseAuditListQuery({ limit: "5" })).toEqual({ limit: 5 });
    expect(() =>
      parseAuditListQuery({ limit: String(AUDIT_LIST_MAX_LIMIT + 1) }),
    ).toThrow(ValidationError);
    expect(() => parseAuditListQuery({ limit: "0" })).toThrow(ValidationError);
    expect(() => parseAuditListQuery({ limit: "1.5" })).toThrow(
      ValidationError,
    );
  });

  it("accepts a cursor and bounds its length", () => {
    expect(parseAuditListQuery({ cursor: "abc" })).toEqual({
      limit: AUDIT_LIST_DEFAULT_LIMIT,
      cursor: "abc",
    });
    expect(() =>
      parseAuditListQuery({ cursor: "a".repeat(MAX_AUDIT_CURSOR_LENGTH + 1) }),
    ).toThrow(ValidationError);
    expect(() => parseAuditListQuery({ cursor: "" })).toThrow(ValidationError);
  });

  it("refuses a parameter it does not declare", () => {
    // An offset is the specific thing this must never accept: it is the
    // pagination the trail deliberately does not support.
    for (const query of [
      { offset: "10" },
      { actorId: "actor-1" },
      { sortBy: "occurredAt" },
      { total: "true" },
    ]) {
      expect(() => parseAuditListQuery(query), JSON.stringify(query)).toThrow(
        ValidationError,
      );
    }
  });
});
