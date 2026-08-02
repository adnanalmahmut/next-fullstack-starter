import { describe, expect, it } from "vitest";

import {
  ADMIN_ENDPOINT,
  ADMIN_ENDPOINT_PREFIX,
  ADMIN_ENDPOINT_RULES,
  SELF_SCOPED_ADMIN_ENDPOINTS,
  findAdminEndpointRule,
  isAdminEndpointPath,
  isSelfScopedAdminEndpointPath,
} from "./admin-endpoints";
import { IDENTITY_AUDIT_ACTION } from "./audit/identity-audit-actions";
import { PERMISSION } from "./permission-registry";

/** Every admin endpoint Better Auth 1.6.25 exposes. */
const everyBetterAuthAdminPath = [
  "/admin/set-role",
  "/admin/get-user",
  "/admin/create-user",
  "/admin/update-user",
  "/admin/list-users",
  "/admin/list-user-sessions",
  "/admin/unban-user",
  "/admin/ban-user",
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
  "/admin/revoke-user-session",
  "/admin/revoke-user-sessions",
  "/admin/remove-user",
  "/admin/set-user-password",
  "/admin/has-permission",
];

const allowlistedPaths = [
  ...ADMIN_ENDPOINT_RULES.map((rule) => rule.path),
  ...SELF_SCOPED_ADMIN_ENDPOINTS,
];

describe("admin endpoint allowlist", () => {
  it("governs exactly the supported operations", () => {
    expect(ADMIN_ENDPOINT_RULES.map((rule) => rule.path)).toEqual([
      "/admin/list-users",
      "/admin/get-user",
      "/admin/set-role",
      "/admin/revoke-user-sessions",
    ]);
  });

  it("requires the matching application capability for each one", () => {
    expect(
      ADMIN_ENDPOINT_RULES.map((rule) => [rule.path, rule.permission]),
    ).toEqual([
      ["/admin/list-users", PERMISSION.IDENTITY_USER_LIST],
      ["/admin/get-user", PERMISSION.IDENTITY_USER_READ],
      ["/admin/set-role", PERMISSION.IDENTITY_USER_SET_ROLE],
      ["/admin/revoke-user-sessions", PERMISSION.IDENTITY_SESSION_REVOKE],
    ]);
  });

  it("audits the two mutations and no read", () => {
    expect(ADMIN_ENDPOINT_RULES.map((rule) => [rule.path, rule.audit])).toEqual(
      [
        ["/admin/list-users", null],
        ["/admin/get-user", null],
        ["/admin/set-role", IDENTITY_AUDIT_ACTION.USER_ROLE_SET],
        ["/admin/revoke-user-sessions", IDENTITY_AUDIT_ACTION.SESSION_REVOKED],
      ],
    );
  });

  it("exempts only the endpoint that reports on the caller itself", () => {
    expect(SELF_SCOPED_ADMIN_ENDPOINTS).toEqual([
      ADMIN_ENDPOINT.HAS_PERMISSION,
    ]);
  });

  it("leaves every other Better Auth admin endpoint unlisted", () => {
    const unlisted = everyBetterAuthAdminPath.filter(
      (path) => !allowlistedPaths.includes(path),
    );

    expect(unlisted).toEqual([
      "/admin/create-user",
      "/admin/update-user",
      "/admin/list-user-sessions",
      "/admin/unban-user",
      "/admin/ban-user",
      "/admin/impersonate-user",
      "/admin/stop-impersonating",
      "/admin/revoke-user-session",
      "/admin/remove-user",
      "/admin/set-user-password",
    ]);

    for (const path of unlisted) {
      expect(findAdminEndpointRule(path), path).toBeUndefined();
      expect(isSelfScopedAdminEndpointPath(path), path).toBe(false);
      expect(isAdminEndpointPath(path), path).toBe(true);
    }
  });
});

describe("isAdminEndpointPath", () => {
  it("recognizes the administrative prefix", () => {
    expect(ADMIN_ENDPOINT_PREFIX).toBe("/admin/");

    for (const path of everyBetterAuthAdminPath) {
      expect(isAdminEndpointPath(path), path).toBe(true);
    }
  });

  it("does not claim an unrelated path", () => {
    for (const path of [
      "/sign-in/email",
      "/sign-out",
      "/get-session",
      "/administrator",
      "/admin",
      "",
    ]) {
      expect(isAdminEndpointPath(path), path).toBe(false);
    }
  });

  it("does not claim a missing path", () => {
    expect(isAdminEndpointPath(undefined)).toBe(false);
    expect(isAdminEndpointPath(null)).toBe(false);
    expect(isAdminEndpointPath(1)).toBe(false);
  });
});

describe("findAdminEndpointRule", () => {
  it("finds a governed endpoint", () => {
    expect(findAdminEndpointRule("/admin/set-role")?.permission).toBe(
      PERMISSION.IDENTITY_USER_SET_ROLE,
    );
  });

  it("finds nothing for an unknown value", () => {
    expect(findAdminEndpointRule("/admin/unknown")).toBeUndefined();
    expect(findAdminEndpointRule(undefined)).toBeUndefined();
    expect(findAdminEndpointRule("")).toBeUndefined();
  });
});
