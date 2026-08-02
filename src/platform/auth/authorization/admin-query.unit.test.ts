import { describe, expect, it } from "vitest";

import { ValidationError } from "@/shared/errors/application-error";

import {
  ADMIN_USERS_DEFAULT_LIMIT,
  ADMIN_USERS_MAX_LIMIT,
  ADMIN_USERS_MAX_OFFSET,
  ADMIN_USERS_SEARCH_FIELD,
  ADMIN_USERS_SORT_FIELDS,
  adminInputSchemas,
  parseAdminUsersQuery,
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

describe("userParams schema", () => {
  const schema = adminInputSchemas.userParams;

  it("accepts a plausible identifier", () => {
    expect(schema.parse({ userId: "user-1" })).toEqual({ userId: "user-1" });
    expect(schema.parse({ userId: "  user-1  " })).toEqual({
      userId: "user-1",
    });
  });

  it("refuses an empty or oversized identifier", () => {
    for (const userId of ["", "   ", "a".repeat(256)]) {
      expect(schema.safeParse({ userId }).success).toBe(false);
    }
  });

  it("refuses a non-string identifier", () => {
    for (const userId of [undefined, null, ["user-1"], 1]) {
      expect(schema.safeParse({ userId }).success).toBe(false);
    }
  });

  it("refuses an unexpected path value", () => {
    expect(schema.safeParse({ userId: "user-1", role: "admin" }).success).toBe(
      false,
    );
  });
});

describe("setRoleBody schema", () => {
  const schema = adminInputSchemas.setRoleBody;

  it("reads the requested role as an untrusted string", () => {
    expect(schema.parse({ role: "admin" })).toEqual({ role: "admin" });
    expect(schema.parse({ role: "superadmin" })).toEqual({
      role: "superadmin",
    });
  });

  it("refuses a missing or non-string role", () => {
    for (const body of [{}, { role: ["admin"] }, { role: null }, null]) {
      expect(schema.safeParse(body).success).toBe(false);
    }
  });

  it("refuses an attempt to name the target in the body", () => {
    expect(
      schema.safeParse({ role: "admin", userId: "another-user" }).success,
    ).toBe(false);
  });
});
