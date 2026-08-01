import { describe, expect, it } from "vitest";

import {
  ConflictError,
  ForbiddenError,
  ValidationError,
} from "@/shared/errors/application-error";

import {
  assertSetRoleAllowed,
  type SetRolePolicyInput,
} from "./set-role.policy";

function input(
  overrides: Partial<SetRolePolicyInput> = {},
): SetRolePolicyInput {
  return {
    actorUserId: "actor-1",
    targetUserId: "target-1",
    targetRoles: ["user"],
    requestedRole: "admin",
    otherAdminCount: 1,
    ...overrides,
  };
}

describe("assertSetRoleAllowed", () => {
  it("allows promoting another user", () => {
    expect(() => assertSetRoleAllowed(input())).not.toThrow();
  });

  it("allows demoting another administrator while one remains", () => {
    expect(() =>
      assertSetRoleAllowed(
        input({
          targetRoles: ["admin"],
          requestedRole: "user",
          otherAdminCount: 1,
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    { name: "an unknown role", requestedRole: "superadmin" },
    { name: "a differently cased role", requestedRole: "Admin" },
    { name: "a comma injected list", requestedRole: "admin,user" },
    { name: "a duplicated list", requestedRole: "admin,admin" },
    { name: "a spaced list", requestedRole: "admin, user" },
    { name: "an empty value", requestedRole: "" },
    { name: "a blank value", requestedRole: "   " },
    { name: "an array", requestedRole: ["admin"] },
    { name: "a null value", requestedRole: null },
    { name: "an undefined value", requestedRole: undefined },
    { name: "a numeric value", requestedRole: 1 },
    { name: "an object", requestedRole: { role: "admin" } },
  ])("refuses $name as invalid input", ({ requestedRole }) => {
    expect(() => assertSetRoleAllowed(input({ requestedRole }))).toThrow(
      ValidationError,
    );
  });

  it("refuses changing your own role", () => {
    expect(() =>
      assertSetRoleAllowed(
        input({ actorUserId: "same-user", targetUserId: "same-user" }),
      ),
    ).toThrow(ForbiddenError);
  });

  it("refuses self-promotion", () => {
    expect(() =>
      assertSetRoleAllowed(
        input({
          actorUserId: "same-user",
          targetUserId: "same-user",
          targetRoles: ["user"],
          requestedRole: "admin",
        }),
      ),
    ).toThrow(ForbiddenError);
  });

  it("refuses an administrator re-asserting their own role", () => {
    expect(() =>
      assertSetRoleAllowed(
        input({
          actorUserId: "same-user",
          targetUserId: "same-user",
          targetRoles: ["admin"],
          requestedRole: "admin",
          otherAdminCount: 0,
        }),
      ),
    ).toThrow(ForbiddenError);
  });

  it("refuses a self demotion while another administrator remains", () => {
    expect(() =>
      assertSetRoleAllowed(
        input({
          actorUserId: "same-user",
          targetUserId: "same-user",
          targetRoles: ["admin"],
          requestedRole: "user",
          otherAdminCount: 1,
        }),
      ),
    ).toThrow(ForbiddenError);
  });

  it("validates the role before every other check", () => {
    expect(() =>
      assertSetRoleAllowed(
        input({
          actorUserId: "same-user",
          targetUserId: "same-user",
          targetRoles: ["admin"],
          requestedRole: "superadmin",
          otherAdminCount: 0,
        }),
      ),
    ).toThrow(ValidationError);
  });

  it("refuses removing the admin role from the last administrator", () => {
    expect(() =>
      assertSetRoleAllowed(
        input({
          targetRoles: ["admin"],
          requestedRole: "user",
          otherAdminCount: 0,
        }),
      ),
    ).toThrow(ConflictError);
  });

  it("reports the conflict rather than the self refusal for the last administrator", () => {
    expect(() =>
      assertSetRoleAllowed(
        input({
          actorUserId: "same-user",
          targetUserId: "same-user",
          targetRoles: ["admin"],
          requestedRole: "user",
          otherAdminCount: 0,
        }),
      ),
    ).toThrow(ConflictError);
  });

  it("refuses the last administrator even when the role is held alongside another", () => {
    expect(() =>
      assertSetRoleAllowed(
        input({
          targetRoles: ["admin", "user"],
          requestedRole: "user",
          otherAdminCount: 0,
        }),
      ),
    ).toThrow(ConflictError);
  });

  it("allows re-asserting the admin role on the last administrator", () => {
    expect(() =>
      assertSetRoleAllowed(
        input({
          targetRoles: ["admin"],
          requestedRole: "admin",
          otherAdminCount: 0,
        }),
      ),
    ).not.toThrow();
  });

  it("does not treat a non-administrator as the last administrator", () => {
    expect(() =>
      assertSetRoleAllowed(
        input({
          targetRoles: ["user"],
          requestedRole: "user",
          otherAdminCount: 0,
        }),
      ),
    ).not.toThrow();
  });

  it("does not treat a similarly named role as the admin role", () => {
    expect(() =>
      assertSetRoleAllowed(
        input({
          targetRoles: ["superadmin"],
          requestedRole: "user",
          otherAdminCount: 0,
        }),
      ),
    ).not.toThrow();
  });
});
