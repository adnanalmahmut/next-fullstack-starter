import { describe, expect, it } from "vitest";

import { ValidationError } from "@/shared/errors/application-error";

import {
  decodeAuditCursor,
  encodeAuditCursor,
  MAX_AUDIT_CURSOR_LENGTH,
} from "./audit-cursor";

const occurredAt = new Date("2026-08-01T12:34:56.789Z");
const id = "0198f0e0-1111-7222-8333-444455556666";

function encode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

describe("the audit cursor", () => {
  it("round trips a position", () => {
    const cursor = decodeAuditCursor(encodeAuditCursor({ occurredAt, id }));

    expect(cursor.id).toBe(id);
    expect(cursor.occurredAt.toISOString()).toBe(occurredAt.toISOString());
  });

  it("stays comfortably inside its own ceiling", () => {
    expect(encodeAuditCursor({ occurredAt, id }).length).toBeLessThan(
      MAX_AUDIT_CURSOR_LENGTH,
    );
  });

  it("carries the position and nothing else", () => {
    const decoded: unknown = JSON.parse(
      Buffer.from(encodeAuditCursor({ occurredAt, id }), "base64url").toString(
        "utf8",
      ),
    );

    expect(Object.keys(decoded as object).sort()).toEqual(["id", "occurredAt"]);
  });

  it("refuses a malformed value", () => {
    for (const value of [
      "",
      "not-base64url-!!!",
      Buffer.from("not json", "utf8").toString("base64url"),
      encode([occurredAt.toISOString(), id]),
      encode("cursor"),
    ]) {
      expect(() => decodeAuditCursor(value), String(value)).toThrow(
        ValidationError,
      );
    }
  });

  it("refuses a value that is not a string", () => {
    for (const value of [undefined, null, 1, { id }]) {
      expect(() => decodeAuditCursor(value)).toThrow(ValidationError);
    }
  });

  it("refuses an oversized value before decoding it", () => {
    expect(() =>
      decodeAuditCursor("A".repeat(MAX_AUDIT_CURSOR_LENGTH + 1)),
    ).toThrow(ValidationError);
  });

  it("refuses an unparseable timestamp", () => {
    expect(() =>
      decodeAuditCursor(encode({ occurredAt: "yesterday", id })),
    ).toThrow(ValidationError);
    expect(() =>
      decodeAuditCursor(encode({ occurredAt: "2026-13-45T00:00:00.000Z", id })),
    ).toThrow(ValidationError);
  });

  it("refuses an identifier that is not a canonical UUID", () => {
    for (const candidate of ["", "1", "'; DROP TABLE audit_record; --"]) {
      expect(() =>
        decodeAuditCursor(
          encode({ occurredAt: occurredAt.toISOString(), id: candidate }),
        ),
      ).toThrow(ValidationError);
    }
  });

  it("refuses an unknown key rather than ignoring it", () => {
    expect(() =>
      decodeAuditCursor(
        encode({ occurredAt: occurredAt.toISOString(), id, limit: 1000 }),
      ),
    ).toThrow(ValidationError);
  });

  it("refuses a missing field", () => {
    expect(() =>
      decodeAuditCursor(encode({ occurredAt: occurredAt.toISOString() })),
    ).toThrow(ValidationError);
    expect(() => decodeAuditCursor(encode({ id }))).toThrow(ValidationError);
  });
});
