import { describe, expect, it } from "vitest";

import type { Actor } from "../actor";

import { toAuditActor } from "./identity-audit-actor";

const actor: Actor = {
  userId: "user-1",
  sessionId: "session-1",
  name: "Ada Lovelace",
  email: "ada@example.test",
  roles: ["admin"],
};

describe("toAuditActor", () => {
  it("keeps only the two identifiers an audit record may hold", () => {
    expect(toAuditActor(actor)).toEqual({
      type: "user",
      id: "user-1",
      sessionId: "session-1",
    });
  });

  it("drops the name, the address, and the roles", () => {
    const serialized = JSON.stringify(toAuditActor(actor));

    expect(serialized).not.toContain("Ada Lovelace");
    expect(serialized).not.toContain("ada@example.test");
    expect(serialized).not.toContain("admin");
  });

  it("is a projection, so a new field on Actor is not carried over", () => {
    const widened = { ...actor, organizationId: "org-1" } as Actor;

    expect(Object.keys(toAuditActor(widened)).sort()).toEqual([
      "id",
      "sessionId",
      "type",
    ]);
  });
});
