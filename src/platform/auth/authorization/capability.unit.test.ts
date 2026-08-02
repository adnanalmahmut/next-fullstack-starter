import { describe, expect, it } from "vitest";

import { authorizeCapabilities, hasCapabilities } from "./capability";
import { PERMISSION, type Permission } from "./permission-registry";
import { ADMIN_ROLE, USER_ROLE } from "./role";

const everyPermission = Object.values(PERMISSION);

describe("hasCapabilities", () => {
  it("grants the admin role every application capability", () => {
    for (const permission of everyPermission) {
      expect(hasCapabilities([ADMIN_ROLE], [permission]), permission).toBe(
        true,
      );
    }
  });

  it("grants the user role nothing", () => {
    for (const permission of everyPermission) {
      expect(hasCapabilities([USER_ROLE], [permission]), permission).toBe(
        false,
      );
    }
  });

  it("falls back to the default role for an empty role list", () => {
    for (const permission of everyPermission) {
      expect(hasCapabilities([], [permission]), permission).toBe(false);
    }
  });

  it("grants through any held role", () => {
    expect(
      hasCapabilities(
        [USER_ROLE, ADMIN_ROLE],
        [PERMISSION.IDENTITY_ADMIN_ACCESS],
      ),
    ).toBe(true);
    expect(
      hasCapabilities(
        [ADMIN_ROLE, USER_ROLE],
        [PERMISSION.IDENTITY_ADMIN_ACCESS],
      ),
    ).toBe(true);
  });

  it("fails closed for an unrecognized role", () => {
    expect(
      hasCapabilities(["superadmin"], [PERMISSION.IDENTITY_ADMIN_ACCESS]),
    ).toBe(false);
    expect(hasCapabilities(["Admin"], [PERMISSION.IDENTITY_ADMIN_ACCESS])).toBe(
      false,
    );
    expect(
      hasCapabilities(["admin,user"], [PERMISSION.IDENTITY_ADMIN_ACCESS]),
    ).toBe(false);
    expect(
      hasCapabilities(["constructor"], [PERMISSION.IDENTITY_ADMIN_ACCESS]),
    ).toBe(false);
  });

  it("requires every listed capability at once", () => {
    expect(
      hasCapabilities(
        [ADMIN_ROLE],
        [PERMISSION.IDENTITY_USER_LIST, PERMISSION.AUDIT_RECORD_READ],
      ),
    ).toBe(true);
    expect(
      hasCapabilities(
        [USER_ROLE],
        [PERMISSION.IDENTITY_USER_LIST, PERMISSION.AUDIT_RECORD_READ],
      ),
    ).toBe(false);
  });

  it("fails closed for an empty permission list", () => {
    expect(hasCapabilities([ADMIN_ROLE], [])).toBe(false);
  });

  it("fails closed for an undeclared permission", () => {
    expect(
      hasCapabilities([ADMIN_ROLE], ["identity.user.delete" as Permission]),
    ).toBe(false);
    expect(hasCapabilities([ADMIN_ROLE], ["identity.*.*" as Permission])).toBe(
      false,
    );
  });
});

describe("authorizeCapabilities", () => {
  it("fails closed without a request", () => {
    expect(authorizeCapabilities([ADMIN_ROLE], null)).toBe(false);
  });

  it("refuses an undeclared resource", () => {
    expect(
      authorizeCapabilities([ADMIN_ROLE], { "catalog.product": ["read"] }),
    ).toBe(false);
  });

  it("refuses an action the admin role does not hold", () => {
    expect(authorizeCapabilities([ADMIN_ROLE], { user: ["delete"] })).toBe(
      false,
    );
    expect(authorizeCapabilities([ADMIN_ROLE], { user: ["ban"] })).toBe(false);
    expect(authorizeCapabilities([ADMIN_ROLE], { user: ["impersonate"] })).toBe(
      false,
    );
    expect(authorizeCapabilities([ADMIN_ROLE], { session: ["delete"] })).toBe(
      false,
    );
  });

  it("allows the Better Auth operations the application performs", () => {
    expect(
      authorizeCapabilities([ADMIN_ROLE], {
        user: ["list", "get", "set-role"],
      }),
    ).toBe(true);
    expect(
      authorizeCapabilities([ADMIN_ROLE], { session: ["list", "revoke"] }),
    ).toBe(true);
  });
});
