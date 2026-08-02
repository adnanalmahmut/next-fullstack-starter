import { describe, expect, it } from "vitest";
import * as z from "zod";

import {
  defineAuditAction,
  isValidAuditActionName,
  isValidAuditResourceType,
  MAX_AUDIT_ACTION_LENGTH,
  MAX_AUDIT_RESOURCE_TYPE_LENGTH,
  parseAuditMetadataForWrite,
} from "./audit-action";

const roleSchema = z.object({ role: z.enum(["user", "admin"]) }).strict();

function define(name: string, resourceType = "identity.user") {
  return defineAuditAction({ name, resourceType, metadataSchema: roleSchema });
}

describe("isValidAuditActionName", () => {
  it("accepts a three-part lowercase name", () => {
    expect(isValidAuditActionName("identity.user.role-set")).toBe(true);
    expect(isValidAuditActionName("identity.session.revoked")).toBe(true);
    expect(isValidAuditActionName("documents.document.published")).toBe(true);
    expect(isValidAuditActionName("a.b.c")).toBe(true);
    expect(isValidAuditActionName("a1.b2.c3")).toBe(true);
  });

  it("refuses anything that is not exactly three well-formed parts", () => {
    for (const name of [
      "identity.user",
      "identity.user.role.set",
      "identity..role-set",
      ".identity.user.role-set",
      "identity.user.role-set.",
      "identity.user.-role",
      "identity.user.1role",
      "identity.user.role set",
      "identity.user.role_set",
      "Identity.user.role-set",
      "identity.user.ROLE-SET",
      "identity.*.role-set",
      "identity.user.*",
      "*",
      "",
    ]) {
      expect(isValidAuditActionName(name), name).toBe(false);
    }
  });

  it("refuses a non-string and an over-long name", () => {
    expect(isValidAuditActionName(undefined)).toBe(false);
    expect(isValidAuditActionName(42)).toBe(false);
    expect(
      isValidAuditActionName(`a.b.${"c".repeat(MAX_AUDIT_ACTION_LENGTH)}`),
    ).toBe(false);
  });
});

describe("isValidAuditResourceType", () => {
  it("accepts a two-part lowercase name", () => {
    expect(isValidAuditResourceType("identity.user")).toBe(true);
    expect(isValidAuditResourceType("documents.document")).toBe(true);
  });

  it("refuses anything else", () => {
    for (const value of [
      "identity",
      "identity.user.extra",
      "Identity.user",
      "identity.",
      "identity.*",
      "",
      null,
      `a.${"b".repeat(MAX_AUDIT_RESOURCE_TYPE_LENGTH)}`,
    ]) {
      expect(isValidAuditResourceType(value), String(value)).toBe(false);
    }
  });
});

describe("defineAuditAction", () => {
  it("keeps the declared name and resource type", () => {
    const definition = define("identity.user.role-set");

    expect(definition.name).toBe("identity.user.role-set");
    expect(definition.resourceType).toBe("identity.user");
  });

  it("does not derive the resource type from the action name", () => {
    // `identity.session.revoked` records a user as its resource, which is the
    // whole reason the two are declared separately.
    const definition = define("identity.session.revoked", "identity.user");

    expect(definition.resourceType).toBe("identity.user");
  });

  it("throws on a malformed action name", () => {
    expect(() => define("identity.user")).toThrow(/not a valid/);
    expect(() => define("Identity.User.RoleSet")).toThrow(/not a valid/);
    expect(() => define("identity.*.role-set")).toThrow(/not a valid/);
  });

  it("throws on a malformed resource type", () => {
    expect(() => define("identity.user.role-set", "identity")).toThrow(
      /not a valid/,
    );
  });

  describe("readStoredMetadata", () => {
    const definition = define("identity.user.role-set");

    it("parses a value that still matches the schema", () => {
      expect(definition.readStoredMetadata({ role: "admin" })).toEqual({
        role: "admin",
      });
    });

    it("withholds a value that no longer matches", () => {
      expect(definition.readStoredMetadata({ role: "superadmin" })).toBeNull();
      expect(definition.readStoredMetadata({ scope: "all" })).toBeNull();
      expect(definition.readStoredMetadata(null)).toBeNull();
      expect(definition.readStoredMetadata("role=admin")).toBeNull();
    });

    it("withholds a value the schema accepted but the policy refuses", () => {
      const transforming = defineAuditAction({
        name: "identity.user.role-set",
        resourceType: "identity.user",
        metadataSchema: z
          .object({ role: z.string() })
          .strict()
          .transform((value) => ({ token: value.role })),
      });

      expect(transforming.readStoredMetadata({ role: "admin" })).toBeNull();
    });
  });
});

describe("parseAuditMetadataForWrite", () => {
  const definition = define("identity.user.role-set");

  it("accepts metadata the schema declares", () => {
    expect(parseAuditMetadataForWrite(definition, { role: "admin" })).toEqual({
      ok: true,
      metadata: { role: "admin" },
    });
  });

  it("refuses an extra key, because the schema is strict", () => {
    expect(
      parseAuditMetadataForWrite(definition, {
        role: "admin",
        extra: "value",
      } as never),
    ).toEqual({ ok: false, reason: "schema-mismatch" });
  });

  it("reports a forbidden key as a policy failure, not a schema failure", () => {
    // The distinction matters: the policy runs first, so a leaked field is
    // named as what it is rather than disguised as an unknown key.
    expect(
      parseAuditMetadataForWrite(definition, { token: "secret" } as never),
    ).toEqual({ ok: false, reason: "forbidden-key" });
  });

  it("applies a schema default and stores what the schema produced", () => {
    const withDefault = defineAuditAction({
      name: "identity.session.revoked",
      resourceType: "identity.user",
      metadataSchema: z
        .object({ scope: z.literal("all").default("all") })
        .strict(),
    });

    expect(parseAuditMetadataForWrite(withDefault, {})).toEqual({
      ok: true,
      metadata: { scope: "all" },
    });
  });

  it("refuses a value the schema produced that could not be stored", () => {
    const transforming = defineAuditAction({
      name: "identity.user.role-set",
      resourceType: "identity.user",
      metadataSchema: z
        .object({ role: z.string() })
        .strict()
        .transform((value) => ({ at: new Date(), role: value.role })),
    });

    expect(parseAuditMetadataForWrite(transforming, { role: "admin" })).toEqual(
      {
        ok: false,
        reason: "not-storable",
      },
    );
  });
});
