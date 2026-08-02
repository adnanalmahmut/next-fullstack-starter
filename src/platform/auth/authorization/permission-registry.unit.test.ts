import { describe, expect, it } from "vitest";

import {
  APPLICATION_STATEMENTS,
  PERMISSION,
  PERMISSIONS,
  findPermissionDefinition,
  isPermission,
  type Permission,
  toPermissionRequest,
} from "./permission-registry";

describe("permission registry", () => {
  it("declares exactly the permissions this change introduces", () => {
    expect(PERMISSIONS).toEqual([
      "identity.admin.access",
      "identity.user.list",
      "identity.user.read",
      "identity.user.set-role",
      "identity.session.revoke",
      "audit.record.read",
    ]);
  });

  it("agrees with the statements in both directions", () => {
    const derived = Object.entries(APPLICATION_STATEMENTS)
      .flatMap(([resource, actions]) =>
        actions.map((action) => `${resource}.${action}`),
      )
      .sort();

    expect([...PERMISSIONS].sort()).toEqual(derived);

    for (const permission of PERMISSIONS) {
      const definition = findPermissionDefinition(permission);

      expect(definition, permission).not.toBeNull();
      expect(`${definition?.resource}.${definition?.action}`).toBe(permission);
    }
  });

  it("uses the module.resource.action convention", () => {
    // The owning module is whichever platform area the resource belongs to.
    // Reading the audit trail is owned by the audit platform, not by identity,
    // because any module can write to that trail.
    const owners = new Set(["identity", "audit"]);

    for (const permission of PERMISSIONS) {
      const segments = permission.split(".");

      expect(segments, permission).toHaveLength(3);
      expect(permission).toBe(permission.toLowerCase());
      expect(owners.has(segments[0]), permission).toBe(true);
      expect(/^[a-z]+(?:-[a-z]+)*$/.test(segments[2]), permission).toBe(true);
    }
  });

  it("names no role and declares no wildcard", () => {
    for (const permission of PERMISSIONS) {
      expect(permission.includes("*"), permission).toBe(false);
      expect(
        /\b(?:user|admin)$/.test(permission.split(".")[2]),
        permission,
      ).toBe(false);
    }

    expect(Object.keys(APPLICATION_STATEMENTS)).not.toContain("*");
  });

  it("declares each permission through a named constant", () => {
    expect(Object.values(PERMISSION).sort()).toEqual([...PERMISSIONS].sort());
    expect(new Set(Object.values(PERMISSION)).size).toBe(PERMISSIONS.length);
  });

  it("recognizes only declared names", () => {
    expect(isPermission(PERMISSION.IDENTITY_ADMIN_ACCESS)).toBe(true);
    expect(isPermission("identity.admin.*")).toBe(false);
    expect(isPermission("identity.user.delete")).toBe(false);
    expect(isPermission("catalog.product.read")).toBe(false);
    expect(isPermission("")).toBe(false);
    expect(isPermission(null)).toBe(false);
    expect(isPermission(42)).toBe(false);
    expect(isPermission("toString")).toBe(false);
  });

  it("builds one request per permission", () => {
    expect(toPermissionRequest([PERMISSION.IDENTITY_ADMIN_ACCESS])).toEqual({
      "identity.admin": ["access"],
    });
    expect(toPermissionRequest([PERMISSION.IDENTITY_USER_SET_ROLE])).toEqual({
      "identity.user": ["set-role"],
    });
  });

  it("groups actions of the same resource into one entry", () => {
    expect(
      toPermissionRequest([
        PERMISSION.IDENTITY_USER_LIST,
        PERMISSION.IDENTITY_USER_READ,
      ]),
    ).toEqual({
      "identity.user": ["list", "read"],
    });
  });

  it("collapses duplicates", () => {
    expect(
      toPermissionRequest([
        PERMISSION.IDENTITY_USER_LIST,
        PERMISSION.IDENTITY_USER_LIST,
      ]),
    ).toEqual({
      "identity.user": ["list"],
    });
  });

  it("keeps separate resources separate", () => {
    expect(
      toPermissionRequest([
        PERMISSION.IDENTITY_USER_READ,
        PERMISSION.AUDIT_RECORD_READ,
      ]),
    ).toEqual({
      "identity.user": ["read"],
      "audit.record": ["read"],
    });
  });

  it("fails closed for an empty request", () => {
    expect(toPermissionRequest([])).toBeNull();
  });

  it("fails closed for an undeclared name", () => {
    expect(
      toPermissionRequest(["identity.user.delete" as Permission]),
    ).toBeNull();
    expect(toPermissionRequest(["identity.*.*" as Permission])).toBeNull();
    expect(
      toPermissionRequest([
        PERMISSION.IDENTITY_USER_LIST,
        "orders.order.refund" as Permission,
      ]),
    ).toBeNull();
  });
});
