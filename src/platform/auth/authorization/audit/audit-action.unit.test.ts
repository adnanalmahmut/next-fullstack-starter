import { describe, expect, it } from "vitest";

import {
  AUDIT_ACTION,
  AUDIT_ACTIONS,
  AUDIT_REVOKE_SCOPE,
  buildRoleSetMetadata,
  buildSessionRevokedMetadata,
  isAuditAction,
  parseAuditMetadata,
} from "./audit-action";

describe("audit actions", () => {
  it("declares exactly the two audited mutations", () => {
    expect(AUDIT_ACTIONS).toEqual([
      "identity.user.role-set",
      "identity.session.revoked",
    ]);
    expect(AUDIT_ACTION.USER_ROLE_SET).toBe("identity.user.role-set");
    expect(AUDIT_ACTION.SESSION_REVOKED).toBe("identity.session.revoked");
  });

  it("recognizes only declared actions", () => {
    expect(isAuditAction(AUDIT_ACTION.USER_ROLE_SET)).toBe(true);
    expect(isAuditAction(AUDIT_ACTION.SESSION_REVOKED)).toBe(true);
    expect(isAuditAction("identity.user.read")).toBe(false);
    expect(isAuditAction("identity.user.deleted")).toBe(false);
    expect(isAuditAction("")).toBe(false);
    expect(isAuditAction(null)).toBe(false);
    expect(isAuditAction(["identity.user.role-set"])).toBe(false);
  });
});

describe("audit metadata builders", () => {
  it("builds the role change metadata for an approved role", () => {
    expect(buildRoleSetMetadata("user")).toEqual({ role: "user" });
    expect(buildRoleSetMetadata("admin")).toEqual({ role: "admin" });
  });

  it("refuses to build metadata for anything but an approved role", () => {
    expect(buildRoleSetMetadata("superadmin")).toBeNull();
    expect(buildRoleSetMetadata("admin,user")).toBeNull();
    expect(buildRoleSetMetadata("")).toBeNull();
    expect(buildRoleSetMetadata(null)).toBeNull();
    expect(buildRoleSetMetadata(["admin"])).toBeNull();
  });

  it("builds the revocation metadata with the supported scope only", () => {
    expect(buildSessionRevokedMetadata()).toEqual({ scope: "all" });
    expect(AUDIT_REVOKE_SCOPE).toBe("all");
  });

  it("keeps the metadata to a single allowlisted key", () => {
    expect(Object.keys(buildRoleSetMetadata("admin") ?? {})).toEqual(["role"]);
    expect(Object.keys(buildSessionRevokedMetadata())).toEqual(["scope"]);
  });
});

describe("parseAuditMetadata", () => {
  it("reads back an allowlisted role shape", () => {
    expect(parseAuditMetadata({ role: "admin" })).toEqual({ role: "admin" });
    expect(parseAuditMetadata({ role: "user" })).toEqual({ role: "user" });
  });

  it("reads back an allowlisted scope shape", () => {
    expect(parseAuditMetadata({ scope: "all" })).toEqual({ scope: "all" });
  });

  it.each([
    { name: "an unapproved role", value: { role: "superadmin" } },
    { name: "an unsupported scope", value: { scope: "current" } },
    { name: "an unknown key", value: { email: "person@example.test" } },
    { name: "extra keys", value: { role: "admin", password: "secret" } },
    { name: "an empty object", value: {} },
    { name: "an array", value: [{ role: "admin" }] },
    { name: "a string", value: "role=admin" },
    { name: "a number", value: 1 },
    { name: "null", value: null },
    { name: "undefined", value: undefined },
  ])("returns null for $name", ({ value }) => {
    expect(parseAuditMetadata(value)).toBeNull();
  });
});
