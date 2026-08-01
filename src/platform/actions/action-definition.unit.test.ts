import { describe, expect, expectTypeOf, it } from "vitest";

import type { Actor } from "@/platform/auth/authorization/actor";
import {
  PERMISSION,
  type Permission,
} from "@/platform/auth/authorization/permission-registry";
import type { NonEmptyPermissions } from "@/platform/auth/authorization/require-permission.server";

import {
  AUTHORIZATION_MODE,
  AUTHORIZATION_MODES,
  type ActionActor,
  type ActionAuthorization,
  type AllPermissionsAuthorization,
  type AnyPermissionAuthorization,
  type ActorAuthorization,
  type PermissionAuthorization,
  type PublicAuthorization,
} from "./action-definition";

describe("authorization modes", () => {
  it("declares the closed set of modes", () => {
    expect(AUTHORIZATION_MODES).toEqual([
      "public",
      "actor",
      "permission",
      "any-permission",
      "all-permissions",
    ]);
  });

  it("covers every declared mode with an authorization shape", () => {
    expectTypeOf<ActionAuthorization["mode"]>().toEqualTypeOf<
      (typeof AUTHORIZATION_MODES)[number]
    >();
  });
});

describe("actor typing", () => {
  it("is null for a public Action", () => {
    expectTypeOf<ActionActor<PublicAuthorization>>().toEqualTypeOf<null>();
  });

  it.each([
    { name: "actor" },
    { name: "permission" },
    { name: "any-permission" },
    { name: "all-permissions" },
  ])("is a guaranteed Actor for the $name mode", () => {
    expectTypeOf<ActionActor<ActorAuthorization>>().toEqualTypeOf<Actor>();
    expectTypeOf<ActionActor<PermissionAuthorization>>().toEqualTypeOf<Actor>();
    expectTypeOf<
      ActionActor<AnyPermissionAuthorization>
    >().toEqualTypeOf<Actor>();
    expectTypeOf<
      ActionActor<AllPermissionsAuthorization>
    >().toEqualTypeOf<Actor>();
  });

  it("never widens a protected actor to include null", () => {
    expectTypeOf<null>().not.toExtend<ActionActor<PermissionAuthorization>>();
    expectTypeOf<Actor | null>().not.toExtend<
      ActionActor<ActorAuthorization>
    >();
  });
});

describe("permission typing", () => {
  it("accepts a registry identifier", () => {
    expectTypeOf<
      typeof PERMISSION.IDENTITY_USER_SET_ROLE
    >().toExtend<Permission>();
    expectTypeOf<{
      mode: typeof AUTHORIZATION_MODE.PERMISSION;
      permission: typeof PERMISSION.IDENTITY_USER_SET_ROLE;
    }>().toExtend<PermissionAuthorization>();
  });

  it("rejects a capability string that the registry does not declare", () => {
    expectTypeOf<"identity.user.delete">().not.toExtend<Permission>();
    expectTypeOf<"identity.*">().not.toExtend<Permission>();
    expectTypeOf<{
      mode: typeof AUTHORIZATION_MODE.PERMISSION;
      permission: "identity.user.delete";
    }>().not.toExtend<PermissionAuthorization>();
  });

  it("rejects an empty permission list in either multi-permission mode", () => {
    expectTypeOf<readonly []>().not.toExtend<NonEmptyPermissions>();
    expectTypeOf<{
      mode: typeof AUTHORIZATION_MODE.ANY_PERMISSION;
      permissions: readonly [];
    }>().not.toExtend<AnyPermissionAuthorization>();
    expectTypeOf<{
      mode: typeof AUTHORIZATION_MODE.ALL_PERMISSIONS;
      permissions: readonly [];
    }>().not.toExtend<AllPermissionsAuthorization>();
  });

  it("accepts a non-empty tuple of registry identifiers", () => {
    expectTypeOf<
      readonly [
        typeof PERMISSION.IDENTITY_USER_LIST,
        typeof PERMISSION.IDENTITY_USER_READ,
      ]
    >().toExtend<NonEmptyPermissions>();
  });
});
