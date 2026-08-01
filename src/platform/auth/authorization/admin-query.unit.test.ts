import { describe, expect, it } from "vitest";

import { ValidationError } from "@/shared/errors/application-error";

import {
  ADMIN_AUDIT_DEFAULT_LIMIT,
  ADMIN_AUDIT_MAX_LIMIT,
  ADMIN_USERS_DEFAULT_LIMIT,
  ADMIN_USERS_MAX_LIMIT,
  ADMIN_USERS_MAX_OFFSET,
  ADMIN_USERS_SEARCH_FIELD,
  ADMIN_USERS_SORT_FIELDS,
  parseAdminAuditQuery,
  parseAdminUsersQuery,
  parseSetRoleBody,
  parseTargetUserId,
  toQueryRecord,
} from "./admin-query";

describe("parseAdminUsersQuery", () => {
  it("applies bounded defaults", () => {
    expect(parseAdminUsersQuery({})).toEqual({
      limit: ADMIN_USERS_DEFAULT_LIMIT,
      offset: 0,
      sortBy: "createdAt",
      sortDirection: "desc",
    });
  });

  it("accepts values inside the bounds", () => {
    expect(
      parseAdminUsersQuery({
        limit: "10",
        offset: "20",
        sortBy: "email",
        sortDirection: "asc",
        search: "  person  ",
      }),
    ).toEqual({
      limit: 10,
      offset: 20,
      sortBy: "email",
      sortDirection: "asc",
      search: "person",
    });
  });

  it("keeps the page bounded", () => {
    expect(() =>
      parseAdminUsersQuery({ limit: String(ADMIN_USERS_MAX_LIMIT + 1) }),
    ).toThrow(ValidationError);
    expect(() => parseAdminUsersQuery({ limit: "0" })).toThrow(ValidationError);
    expect(() => parseAdminUsersQuery({ limit: "-1" })).toThrow(
      ValidationError,
    );
    expect(() => parseAdminUsersQuery({ limit: "1.5" })).toThrow(
      ValidationError,
    );
    expect(() => parseAdminUsersQuery({ limit: "all" })).toThrow(
      ValidationError,
    );
    expect(() =>
      parseAdminUsersQuery({ offset: String(ADMIN_USERS_MAX_OFFSET + 1) }),
    ).toThrow(ValidationError);
    expect(() => parseAdminUsersQuery({ offset: "-1" })).toThrow(
      ValidationError,
    );
  });

  it("allows only allowlisted sort fields and directions", () => {
    expect(ADMIN_USERS_SORT_FIELDS).toEqual(["createdAt", "email", "name"]);

    for (const sortBy of ADMIN_USERS_SORT_FIELDS) {
      expect(parseAdminUsersQuery({ sortBy }).sortBy).toBe(sortBy);
    }

    expect(() => parseAdminUsersQuery({ sortBy: "password" })).toThrow(
      ValidationError,
    );
    expect(() => parseAdminUsersQuery({ sortBy: "role" })).toThrow(
      ValidationError,
    );
    expect(() => parseAdminUsersQuery({ sortDirection: "random" })).toThrow(
      ValidationError,
    );
  });

  it("names the single searchable field itself", () => {
    expect(ADMIN_USERS_SEARCH_FIELD).toBe("email");
  });

  it("rejects a caller-named field, operator, or filter", () => {
    expect(() => parseAdminUsersQuery({ searchField: "password" })).toThrow(
      ValidationError,
    );
    expect(() => parseAdminUsersQuery({ searchOperator: "eq" })).toThrow(
      ValidationError,
    );
    expect(() => parseAdminUsersQuery({ filterField: "role" })).toThrow(
      ValidationError,
    );
    expect(() => parseAdminUsersQuery({ filterValue: "admin" })).toThrow(
      ValidationError,
    );
  });

  it("bounds the search term", () => {
    expect(() => parseAdminUsersQuery({ search: "" })).toThrow(ValidationError);
    expect(() => parseAdminUsersQuery({ search: "   " })).toThrow(
      ValidationError,
    );
    expect(() => parseAdminUsersQuery({ search: "a".repeat(101) })).toThrow(
      ValidationError,
    );
  });

  it("rejects a non-object input", () => {
    expect(() => parseAdminUsersQuery("limit=10")).toThrow(ValidationError);
    expect(() => parseAdminUsersQuery(null)).toThrow(ValidationError);
  });
});

describe("parseAdminAuditQuery", () => {
  it("applies a bounded default", () => {
    expect(parseAdminAuditQuery({})).toEqual({
      limit: ADMIN_AUDIT_DEFAULT_LIMIT,
    });
  });

  it("keeps the page bounded", () => {
    expect(parseAdminAuditQuery({ limit: "5" })).toEqual({ limit: 5 });
    expect(() =>
      parseAdminAuditQuery({ limit: String(ADMIN_AUDIT_MAX_LIMIT + 1) }),
    ).toThrow(ValidationError);
    expect(() => parseAdminAuditQuery({ limit: "0" })).toThrow(ValidationError);
  });

  it("rejects an unknown parameter", () => {
    expect(() => parseAdminAuditQuery({ actorUserId: "actor-1" })).toThrow(
      ValidationError,
    );
  });
});

describe("parseTargetUserId", () => {
  it("accepts a plausible identifier", () => {
    expect(parseTargetUserId("user-1")).toBe("user-1");
    expect(parseTargetUserId("  user-1  ")).toBe("user-1");
  });

  it("refuses an empty or oversized identifier", () => {
    expect(() => parseTargetUserId("")).toThrow(ValidationError);
    expect(() => parseTargetUserId("   ")).toThrow(ValidationError);
    expect(() => parseTargetUserId("a".repeat(256))).toThrow(ValidationError);
  });

  it("refuses a non-string identifier", () => {
    expect(() => parseTargetUserId(undefined)).toThrow(ValidationError);
    expect(() => parseTargetUserId(null)).toThrow(ValidationError);
    expect(() => parseTargetUserId(["user-1"])).toThrow(ValidationError);
    expect(() => parseTargetUserId(1)).toThrow(ValidationError);
  });
});

describe("parseSetRoleBody", () => {
  it("reads the requested role as an untrusted string", () => {
    expect(parseSetRoleBody({ role: "admin" })).toEqual({ role: "admin" });
    expect(parseSetRoleBody({ role: "superadmin" })).toEqual({
      role: "superadmin",
    });
  });

  it("refuses a missing or non-string role", () => {
    expect(() => parseSetRoleBody({})).toThrow(ValidationError);
    expect(() => parseSetRoleBody({ role: ["admin"] })).toThrow(
      ValidationError,
    );
    expect(() => parseSetRoleBody({ role: null })).toThrow(ValidationError);
    expect(() => parseSetRoleBody(null)).toThrow(ValidationError);
  });

  it("refuses an attempt to name the target in the body", () => {
    expect(() =>
      parseSetRoleBody({ role: "admin", userId: "another-user" }),
    ).toThrow(ValidationError);
  });
});

describe("toQueryRecord", () => {
  it("turns search parameters into a plain object", () => {
    expect(toQueryRecord(new URLSearchParams("limit=10&sortBy=email"))).toEqual(
      {
        limit: "10",
        sortBy: "email",
      },
    );
  });

  it("produces an empty object for no parameters", () => {
    expect(toQueryRecord(new URLSearchParams())).toEqual({});
  });
});
