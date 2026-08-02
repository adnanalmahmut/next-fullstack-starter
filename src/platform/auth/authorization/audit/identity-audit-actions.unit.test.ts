import { describe, expect, it } from "vitest";

import {
  IDENTITY_AUDIT_ACTION,
  IDENTITY_AUDIT_ACTIONS,
  IDENTITY_AUDIT_RESOURCE_TYPE,
  IDENTITY_REVOKE_SCOPE,
  sessionRevokedAudit,
  userRoleSetAudit,
} from "./identity-audit-actions";

describe("the identity audit actions", () => {
  it("keeps the names that are already in the stored history", () => {
    expect(IDENTITY_AUDIT_ACTION.USER_ROLE_SET).toBe("identity.user.role-set");
    expect(IDENTITY_AUDIT_ACTION.SESSION_REVOKED).toBe(
      "identity.session.revoked",
    );
  });

  it("declares both against the user resource", () => {
    // Including the revocation, whose target has always been a user.
    expect(userRoleSetAudit.resourceType).toBe(IDENTITY_AUDIT_RESOURCE_TYPE);
    expect(sessionRevokedAudit.resourceType).toBe(IDENTITY_AUDIT_RESOURCE_TYPE);
    expect(IDENTITY_AUDIT_RESOURCE_TYPE).toBe("identity.user");
  });

  it("exposes exactly the two actions, in declaration order", () => {
    expect(IDENTITY_AUDIT_ACTIONS.map((action) => action.name)).toEqual([
      "identity.user.role-set",
      "identity.session.revoked",
    ]);
  });

  describe("role-set metadata", () => {
    it("accepts an approved role", () => {
      expect(userRoleSetAudit.readStoredMetadata({ role: "admin" })).toEqual({
        role: "admin",
      });
      expect(userRoleSetAudit.readStoredMetadata({ role: "user" })).toEqual({
        role: "user",
      });
    });

    it("refuses anything else, including an extra key", () => {
      expect(
        userRoleSetAudit.readStoredMetadata({ role: "superadmin" }),
      ).toBeNull();
      expect(
        userRoleSetAudit.readStoredMetadata({
          role: "admin",
          email: "a@b.test",
        }),
      ).toBeNull();
      expect(userRoleSetAudit.readStoredMetadata({})).toBeNull();
    });
  });

  describe("session-revoked metadata", () => {
    it("accepts the one supported scope", () => {
      expect(
        sessionRevokedAudit.readStoredMetadata({
          scope: IDENTITY_REVOKE_SCOPE,
        }),
      ).toEqual({ scope: "all" });
    });

    it("refuses a scope this application does not support", () => {
      expect(
        sessionRevokedAudit.readStoredMetadata({ scope: "one" }),
      ).toBeNull();
      expect(
        sessionRevokedAudit.readStoredMetadata({ role: "admin" }),
      ).toBeNull();
    });
  });

  it("stores no identifier in metadata, because those have columns", () => {
    expect(
      userRoleSetAudit.readStoredMetadata({
        role: "admin",
        actorUserId: "actor-1",
      }),
    ).toBeNull();
    expect(
      sessionRevokedAudit.readStoredMetadata({
        scope: "all",
        targetUserId: "target-1",
      }),
    ).toBeNull();
  });
});
