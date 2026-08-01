import { describe, expect, it } from "vitest";

import {
  ADMIN_ROLE,
  ADMIN_ROLES,
  AUTHORIZATION_ROLE_NAMES,
  DEFAULT_ROLE,
  USER_ROLE,
  isAuthorizationRole,
  normalizeRoles,
} from "./role";

describe("role names", () => {
  it("declares a closed set", () => {
    expect(USER_ROLE).toBe("user");
    expect(ADMIN_ROLE).toBe("admin");
    expect(AUTHORIZATION_ROLE_NAMES).toEqual(["user", "admin"]);
    expect(DEFAULT_ROLE).toBe("user");
    expect(ADMIN_ROLES).toEqual(["admin"]);
  });

  it("recognizes only declared roles", () => {
    expect(isAuthorizationRole("user")).toBe(true);
    expect(isAuthorizationRole("admin")).toBe(true);
    expect(isAuthorizationRole("Admin")).toBe(false);
    expect(isAuthorizationRole("superadmin")).toBe(false);
    expect(isAuthorizationRole("admin,user")).toBe(false);
    expect(isAuthorizationRole("")).toBe(false);
    expect(isAuthorizationRole(null)).toBe(false);
    expect(isAuthorizationRole(["admin"])).toBe(false);
  });
});

describe("normalizeRoles", () => {
  it("reads a single stored role", () => {
    expect(normalizeRoles("user")).toEqual(["user"]);
    expect(normalizeRoles("admin")).toEqual(["admin"]);
  });

  it("reads the comma separated multi-role representation", () => {
    expect(normalizeRoles("admin,user")).toEqual(["admin", "user"]);
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeRoles(" admin , user ")).toEqual(["admin", "user"]);
    expect(normalizeRoles("\tadmin\n")).toEqual(["admin"]);
  });

  it("removes duplicates while keeping order", () => {
    expect(normalizeRoles("admin,user,admin")).toEqual(["admin", "user"]);
  });

  it("drops empty entries", () => {
    expect(normalizeRoles("admin,,user")).toEqual(["admin", "user"]);
    expect(normalizeRoles(",")).toEqual([]);
    expect(normalizeRoles("   ")).toEqual([]);
    expect(normalizeRoles("")).toEqual([]);
  });

  it("returns an empty list for a missing column", () => {
    expect(normalizeRoles(null)).toEqual([]);
    expect(normalizeRoles(undefined)).toEqual([]);
  });

  it("returns an empty list for a non-string column", () => {
    expect(normalizeRoles(["admin"])).toEqual([]);
    expect(normalizeRoles({ role: "admin" })).toEqual([]);
    expect(normalizeRoles(1)).toEqual([]);
  });

  it("keeps an unrecognized entry visible without approving it", () => {
    expect(normalizeRoles("superadmin")).toEqual(["superadmin"]);
    expect(isAuthorizationRole(normalizeRoles("superadmin")[0])).toBe(false);
  });
});
