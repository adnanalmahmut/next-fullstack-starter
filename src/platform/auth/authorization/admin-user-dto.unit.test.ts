import { describe, expect, it } from "vitest";

import { InternalError } from "@/shared/errors/application-error";

import { toAdminUserDto, toAdminUserDtos } from "./admin-user-dto";

const providerUser = {
  id: "user-1",
  name: "Test Person",
  email: "person@example.test",
  emailVerified: false,
  image: null,
  role: "admin",
  banned: false,
  banReason: null,
  banExpires: null,
  createdAt: new Date("2026-08-01T09:00:00.000Z"),
  updatedAt: new Date("2026-08-01T09:30:00.000Z"),
};

describe("toAdminUserDto", () => {
  it("exposes only the allowlisted fields", () => {
    expect(Object.keys(toAdminUserDto(providerUser)).sort()).toEqual([
      "createdAt",
      "email",
      "emailVerified",
      "id",
      "name",
      "roles",
    ]);
  });

  it("maps the fields it keeps", () => {
    expect(toAdminUserDto(providerUser)).toEqual({
      id: "user-1",
      name: "Test Person",
      email: "person@example.test",
      emailVerified: false,
      roles: ["admin"],
      createdAt: "2026-08-01T09:00:00.000Z",
    });
  });

  it("drops ban metadata and every other provider field", () => {
    const serialized = JSON.stringify(toAdminUserDto(providerUser));

    for (const field of [
      "banned",
      "banReason",
      "banExpires",
      "updatedAt",
      "image",
      "password",
      "token",
      "ipAddress",
      "userAgent",
    ]) {
      expect(serialized.includes(field), field).toBe(false);
    }
  });

  it("normalizes the stored role column", () => {
    expect(
      toAdminUserDto({ ...providerUser, role: " admin , user " }).roles,
    ).toEqual(["admin", "user"]);
    expect(toAdminUserDto({ ...providerUser, role: null }).roles).toEqual([]);
    expect(toAdminUserDto({ ...providerUser, role: undefined }).roles).toEqual(
      [],
    );
  });

  it("accepts a serialized timestamp", () => {
    expect(
      toAdminUserDto({ ...providerUser, createdAt: "2026-08-01T09:00:00.000Z" })
        .createdAt,
    ).toBe("2026-08-01T09:00:00.000Z");
  });

  it.each([
    { name: "a missing id", value: { ...providerUser, id: undefined } },
    { name: "an empty id", value: { ...providerUser, id: "" } },
    { name: "a missing email", value: { ...providerUser, email: undefined } },
    {
      name: "a non-boolean verification flag",
      value: { ...providerUser, emailVerified: "yes" },
    },
    {
      name: "an unparsable timestamp",
      value: { ...providerUser, createdAt: "not-a-date" },
    },
    { name: "a string payload", value: "user-1" },
    { name: "null", value: null },
    { name: "undefined", value: undefined },
  ])("refuses $name", ({ value }) => {
    expect(() => toAdminUserDto(value)).toThrow(InternalError);
  });
});

describe("toAdminUserDtos", () => {
  it("maps every user", () => {
    expect(
      toAdminUserDtos([
        providerUser,
        { ...providerUser, id: "user-2", role: "user" },
      ]).map((user) => [user.id, user.roles]),
    ).toEqual([
      ["user-1", ["admin"]],
      ["user-2", ["user"]],
    ]);
  });

  it("maps an empty list", () => {
    expect(toAdminUserDtos([])).toEqual([]);
  });

  it("refuses the whole page when one entry is unusable", () => {
    expect(() => toAdminUserDtos([providerUser, { id: "user-2" }])).toThrow(
      InternalError,
    );
  });
});
