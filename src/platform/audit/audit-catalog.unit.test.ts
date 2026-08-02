import { describe, expect, it } from "vitest";
import * as z from "zod";

import { defineAuditAction } from "./audit-action";
import { createAuditCatalog, EMPTY_AUDIT_CATALOG } from "./audit-catalog";

const roleSet = defineAuditAction({
  name: "identity.user.role-set",
  resourceType: "identity.user",
  metadataSchema: z.object({ role: z.enum(["user", "admin"]) }).strict(),
});

const sessionRevoked = defineAuditAction({
  name: "identity.session.revoked",
  resourceType: "identity.user",
  metadataSchema: z.object({ scope: z.literal("all") }).strict(),
});

describe("createAuditCatalog", () => {
  it("finds a declared action and reports the ones it knows", () => {
    const catalog = createAuditCatalog([roleSet, sessionRevoked]);

    expect(catalog.names).toEqual([
      "identity.user.role-set",
      "identity.session.revoked",
    ]);
    expect(catalog.has("identity.user.role-set")).toBe(true);
    expect(catalog.find("identity.user.role-set")).toBe(roleSet);
  });

  it("answers null for an action it has never heard of", () => {
    const catalog = createAuditCatalog([roleSet]);

    expect(catalog.has("documents.document.published")).toBe(false);
    expect(catalog.find("documents.document.published")).toBeNull();
  });

  it("refuses two definitions under one name", () => {
    const other = defineAuditAction({
      name: "identity.user.role-set",
      resourceType: "identity.user",
      metadataSchema: z.object({ scope: z.literal("all") }).strict(),
    });

    expect(() => createAuditCatalog([roleSet, other])).toThrow(
      /declared more than once/,
    );
  });

  it("refuses a malformed definition that did not come from the factory", () => {
    const forged = {
      name: "Identity.User",
      resourceType: "identity.user",
      readStoredMetadata: () => null,
    };

    expect(() => createAuditCatalog([forged])).toThrow(/malformed/);
  });

  it("is a value, not a registry: two catalogs are independent", () => {
    const one = createAuditCatalog([roleSet]);
    const two = createAuditCatalog([sessionRevoked]);

    expect(one.has("identity.session.revoked")).toBe(false);
    expect(two.has("identity.user.role-set")).toBe(false);
  });

  it("holds no action when it was given none", () => {
    expect(EMPTY_AUDIT_CATALOG.names).toEqual([]);
    expect(EMPTY_AUDIT_CATALOG.find("identity.user.role-set")).toBeNull();
  });
});
